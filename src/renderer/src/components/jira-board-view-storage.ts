import type { JiraBoardSelection } from '../../../shared/jira/jira-types'
import { normalizeJiraBoardSelection } from '../../../shared/jira/jira-board-selection'
import {
  isDefaultJiraBoardViewPreferences,
  normalizeJiraBoardScopedViewPreferences,
  normalizeJiraBoardViewPreferencesByBoard,
  resolveJiraBoardViewPreferences,
  trimJiraBoardViewPreferencesByBoard,
  type JiraBoardScopedViewPreferences,
  type JiraBoardViewPreferences
} from '../../../shared/jira-board-view-preferences'

// Why: view preferences and the last-picked board are per-device, not host state. Routing them
// through `ui.set` put them inside a strict nested schema, where a host that predates the
// fields silently discarded the WHOLE taskResumeState — github and jira included.
const STORAGE_KEY = 'orca.jira.board-view.v1'
// Why a second key: the global value stays the device's last-used snapshot (and what a build
// without per-board storage reads), while each board keeps its own choices here.
const BY_BOARD_STORAGE_KEY = 'orca.jira.board-view.by-board.v1'
const SELECTION_STORAGE_KEY = 'orca.jira.board-selection.v1'

export type JiraBoardDevicePick = {
  selection: JiraBoardSelection
  /** Picked while a curated set was in force, so removing every saved board hides it. */
  curated: boolean
}

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    // Parse in its own guard: corrupt JSON must fall back without hiding a storage failure.
    return raw ? JSON.parse(raw) : undefined
  } catch {
    return undefined
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // The live board stays usable when browser storage is unavailable or full.
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readGlobalPreferences(): JiraBoardViewPreferences {
  return resolveJiraBoardViewPreferences(readJson(STORAGE_KEY))
}

function readByBoard(): {
  migrated: boolean
  boards: Record<string, JiraBoardScopedViewPreferences>
} {
  const raw = readJson(BY_BOARD_STORAGE_KEY)
  return {
    migrated: isPlainObject(raw) && raw.migrated === true,
    boards: normalizeJiraBoardViewPreferencesByBoard(isPlainObject(raw) ? raw.boards : undefined)
  }
}

function writeByBoard(payload: {
  migrated: boolean
  boards: Record<string, JiraBoardScopedViewPreferences>
}): void {
  try {
    localStorage.setItem(BY_BOARD_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // The live board stays usable when browser storage is unavailable or full.
  }
}

function writeGlobalPreferences(preferences: JiraBoardViewPreferences): void {
  try {
    // Normalization returns undefined for an all-defaults view, so resetting the
    // board clears the key instead of pinning today's defaults against a future change.
    if (isDefaultJiraBoardViewPreferences(preferences)) {
      localStorage.removeItem(STORAGE_KEY)
      return
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // The live board stays usable when browser storage is unavailable or full.
  }
}

/**
 * The view preferences for one board, or the device's global value when no board is chosen.
 *
 * A board with no entry of its own follows the device's habits for everything it has not set,
 * except the typed query — that belongs to one board's issues and must not leak onto another.
 * The exception is the first board read after an upgrade: the device's pre-upgrade value is
 * adopted for it wholesale, query included, so an existing single-board user keeps their view.
 */
export function loadJiraBoardViewPreferences(boardKey?: string | null): JiraBoardViewPreferences {
  const global = readGlobalPreferences()
  if (!boardKey) {
    return global
  }
  const payload = readByBoard()
  const scoped = payload.boards[boardKey]
  if (scoped) {
    return { ...global, ...scoped }
  }
  const legacy = readJson(STORAGE_KEY)
  if (
    !payload.migrated &&
    Object.keys(payload.boards).length === 0 &&
    isPlainObject(legacy) &&
    !isDefaultJiraBoardViewPreferences(global)
  ) {
    writeByBoard({ migrated: true, boards: { [boardKey]: global } })
    return global
  }
  return { ...global, query: '' }
}

export function saveJiraBoardViewPreferences(
  preferences: JiraBoardViewPreferences,
  boardKey?: string | null
): void {
  if (!boardKey) {
    writeGlobalPreferences(preferences)
    return
  }
  const payload = readByBoard()
  const boards = { ...payload.boards }
  // Re-insert so write order stays recency order for the cap below.
  delete boards[boardKey]
  // Why an entry even at the defaults: without it the board would inherit whatever board was
  // used next, and switching back would silently adopt another board's tab and filter.
  const scoped = normalizeJiraBoardScopedViewPreferences(preferences)
  if (scoped) {
    boards[boardKey] = scoped
  }
  writeByBoard({ migrated: true, boards: trimJiraBoardViewPreferencesByBoard(boards) })
  // Why also the global key: a board the user has not opened yet inherits the device's last
  // choices, which is the only behaviour a single-board build could have shown them.
  writeGlobalPreferences(preferences)
}

export function updateJiraBoardViewPreferences(
  updates: Partial<JiraBoardViewPreferences>,
  boardKey?: string | null
): void {
  saveJiraBoardViewPreferences({ ...loadJiraBoardViewPreferences(boardKey), ...updates }, boardKey)
}

/** The board this device last picked in the Tasks switcher, and whether it was picked from a
 *  curated set (a setting, so the pick must not outlive the board being removed from it). A
 *  device preference, not a setting: the curated set is the user's, but which board is open
 *  belongs to this machine. */
export function loadJiraBoardDevicePick(): JiraBoardDevicePick | null {
  const raw = readJson(SELECTION_STORAGE_KEY)
  const selection = normalizeJiraBoardSelection(raw)
  if (!selection) {
    return null
  }
  return { selection, curated: isPlainObject(raw) && raw.curated === true }
}

export function saveJiraBoardDevicePick(pick: JiraBoardDevicePick | null): void {
  const selection = pick ? normalizeJiraBoardSelection(pick.selection) : null
  if (!pick || !selection) {
    try {
      localStorage.removeItem(SELECTION_STORAGE_KEY)
    } catch {
      // Nothing to clear when storage is unavailable.
    }
    return
  }
  writeJson(SELECTION_STORAGE_KEY, { ...selection, curated: pick.curated })
}
