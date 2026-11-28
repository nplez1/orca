import type { JiraBoard, JiraBoardSelection, JiraConnectionStatus, JiraSite } from './jira-types'

/** Boards are stored, compared and cached by one key. Both halves are encoded because a
 *  self-hosted site id is not guaranteed to be free of the separator. */
export function jiraBoardSelectionKey(
  selection: Pick<JiraBoardSelection, 'siteId' | 'boardId'>
): string {
  return `${encodeURIComponent(selection.siteId)}:${encodeURIComponent(selection.boardId)}`
}

const BOARD_NAME_MAX_LENGTH = 200
/** Matches the settings picker's one-page-per-site board list; a longer set is a mistake. */
const BOARD_SET_MAX_ENTRIES = 50

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function trimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

// Why `unknown`: these are persisted values, so a hand-edited settings file is the crash site.
export function normalizeJiraBoardSelection(value: unknown): JiraBoardSelection | null {
  if (!isPlainObject(value)) {
    return null
  }
  const boardId = trimmedString(value.boardId)
  const siteId = trimmedString(value.siteId)
  if (!boardId || !siteId) {
    return null
  }
  const name = trimmedString(value.name)
  return {
    boardId,
    siteId,
    ...(name ? { name: name.slice(0, BOARD_NAME_MAX_LENGTH) } : {})
  }
}

/** A stored set, cleaned: invalid entries dropped, duplicates collapsed to the first, and an
 *  empty result treated as sticky-all rather than as "no boards". */
export function normalizeJiraBoardSet(value: unknown): JiraBoardSelection[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const seen = new Set<string>()
  const set: JiraBoardSelection[] = []
  for (const entry of value) {
    const selection = normalizeJiraBoardSelection(entry)
    if (!selection) {
      continue
    }
    const key = jiraBoardSelectionKey(selection)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    set.push(selection)
    if (set.length === BOARD_SET_MAX_ENTRIES) {
      break
    }
  }
  return set.length > 0 ? set : null
}

/** The curated set, with `defaultJiraBoard` folded in.
 *
 *  `null` means sticky-all: the switcher offers every board the account can see. The single
 *  board is still written by older builds and replicated hosts, so a set that does not contain
 *  it keeps it first rather than letting one host silently drop the other's selection. */
export function effectiveJiraBoardSet(settings: {
  defaultJiraBoards?: unknown
  defaultJiraBoard?: unknown
}): JiraBoardSelection[] | null {
  const set = normalizeJiraBoardSet(settings.defaultJiraBoards)
  const legacy = normalizeJiraBoardSelection(settings.defaultJiraBoard)
  if (!set) {
    return legacy ? [legacy] : null
  }
  if (!legacy) {
    return set
  }
  const legacyKey = jiraBoardSelectionKey(legacy)
  if (set.some((selection) => jiraBoardSelectionKey(selection) === legacyKey)) {
    return set
  }
  return [legacy, ...set].slice(0, BOARD_SET_MAX_ENTRIES)
}

/** The setting pair a write produces, so the mirrored single board cannot drift from the set. */
export function jiraBoardSettingsWrite(set: JiraBoardSelection[] | null): {
  defaultJiraBoards: JiraBoardSelection[] | null
  defaultJiraBoard: JiraBoardSelection | null
} {
  const normalized = normalizeJiraBoardSet(set)
  return {
    defaultJiraBoards: normalized,
    defaultJiraBoard: normalized?.[0] ?? null
  }
}

/** `null` means the connection status cannot say which sites are reachable yet (an older host
 *  omits `sites`), so nothing may be filtered on connectivity. */
export function connectedJiraSiteIds(
  status: Pick<JiraConnectionStatus, 'connected' | 'sites'> | null | undefined,
  ready: boolean
): ReadonlySet<string> | null {
  const sites = status?.sites
  if (!ready || !status?.connected || !sites?.length) {
    return null
  }
  return new Set(sites.map((site) => site.id).filter(Boolean))
}

export function resolveJiraSelectedBoard(input: {
  savedBoards: JiraBoardSelection[] | null
  lastSelected: JiraBoardSelection | null
  connectedSiteIds: ReadonlySet<string> | null
}): JiraBoardSelection | null {
  const reachable = (selection: JiraBoardSelection): boolean =>
    !input.connectedSiteIds || input.connectedSiteIds.has(selection.siteId)
  if (!input.savedBoards) {
    return input.lastSelected && reachable(input.lastSelected) ? input.lastSelected : null
  }
  const available = input.savedBoards.filter(reachable)
  const rememberedKey = input.lastSelected ? jiraBoardSelectionKey(input.lastSelected) : null
  const remembered = rememberedKey
    ? available.find((selection) => jiraBoardSelectionKey(selection) === rememberedKey)
    : undefined
  // Why the saved entry and not the remembered one: the set carries the curated name.
  return remembered ?? available[0] ?? null
}

export type JiraBoardSwitcherOption = {
  selection: JiraBoardSelection
  label: string
  siteLabel: string | null
  /** The board's site is not reachable right now, so picking it cannot work. */
  stale: boolean
}

export function describeJiraBoardSelections(input: {
  selections: readonly JiraBoardSelection[]
  sites: readonly JiraSite[]
  connectedSiteIds: ReadonlySet<string> | null
}): JiraBoardSwitcherOption[] {
  const siteNames = new Map(input.sites.map((site) => [site.id, site.displayName]))
  return input.selections.map((selection) => ({
    selection,
    label: selection.name?.trim() || `Board ${selection.boardId}`,
    siteLabel: siteNames.get(selection.siteId) ?? null,
    stale: Boolean(input.connectedSiteIds && !input.connectedSiteIds.has(selection.siteId))
  }))
}

/** Live board-list results as selections, so the switcher renders both sources the same way. */
export function jiraBoardSelectionsFromBoards(boards: readonly JiraBoard[]): JiraBoardSelection[] {
  return boards.map((board) => ({ boardId: board.id, siteId: board.siteId, name: board.name }))
}

export function addJiraBoardSelection(
  set: readonly JiraBoardSelection[] | null,
  selection: JiraBoardSelection
): JiraBoardSelection[] {
  const current = set ?? []
  const key = jiraBoardSelectionKey(selection)
  if (current.some((entry) => jiraBoardSelectionKey(entry) === key)) {
    return [...current]
  }
  return [...current, selection].slice(0, BOARD_SET_MAX_ENTRIES)
}

export function removeJiraBoardSelection(
  set: readonly JiraBoardSelection[],
  key: string
): JiraBoardSelection[] {
  return set.filter((entry) => jiraBoardSelectionKey(entry) !== key)
}

export function moveJiraBoardSelection(
  set: readonly JiraBoardSelection[],
  key: string,
  offset: -1 | 1
): JiraBoardSelection[] {
  const from = set.findIndex((entry) => jiraBoardSelectionKey(entry) === key)
  const to = from + offset
  if (from === -1 || to < 0 || to >= set.length) {
    return [...set]
  }
  const next = [...set]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}
