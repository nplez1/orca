import {
  normalizeJiraBoardViewPreferences,
  resolveJiraBoardViewPreferences,
  type JiraBoardViewPreferences
} from '../../../shared/jira-board-view-preferences'

// Why: view preferences are per-device, not host state. Routing them through
// `ui.set` put them inside a strict nested schema, where a host that predates the
// fields silently discarded the WHOLE taskResumeState — github and jira included.
const STORAGE_KEY = 'orca.jira.board-view.v1'

function readStoredValue(): unknown {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    // Parse in its own guard: corrupt JSON must fall back without hiding a storage failure.
    return raw ? JSON.parse(raw) : undefined
  } catch {
    return undefined
  }
}

export function loadJiraBoardViewPreferences(): JiraBoardViewPreferences {
  return resolveJiraBoardViewPreferences(readStoredValue())
}

export function saveJiraBoardViewPreferences(preferences: JiraBoardViewPreferences): void {
  try {
    // Normalization returns undefined for an all-defaults view, so resetting the
    // board clears the key instead of pinning today's defaults against a future change.
    const normalized = normalizeJiraBoardViewPreferences(preferences)
    if (!normalized) {
      localStorage.removeItem(STORAGE_KEY)
      return
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    // The live board stays usable when browser storage is unavailable or full.
  }
}

export function updateJiraBoardViewPreferences(updates: Partial<JiraBoardViewPreferences>): void {
  saveJiraBoardViewPreferences({ ...loadJiraBoardViewPreferences(), ...updates })
}
