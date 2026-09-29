// Per-device Jira board view preferences (which view, which filter, typed query).
//
// Why these do not live in `taskResumeState`: that schema is `.strict()` behind a
// field-level `.catch`, so a host that predates a key rejects the WHOLE payload and
// drops the github/jira resume state with it. Per-device view preferences belong in
// client-local storage, mirroring `linear/issue-view-resume-state`.

export const JIRA_BOARD_VIEW_MODES = ['board', 'list'] as const
export const JIRA_BOARD_ACTIVE_VIEWS = ['sprint', 'backlog'] as const
export const JIRA_BOARD_FILTERS = ['me', 'all'] as const

export type JiraBoardViewMode = (typeof JIRA_BOARD_VIEW_MODES)[number]
export type JiraBoardActiveView = (typeof JIRA_BOARD_ACTIVE_VIEWS)[number]
export type JiraBoardFilter = (typeof JIRA_BOARD_FILTERS)[number]

export type JiraBoardViewPreferences = {
  /** Board (kanban/sprint) vs the flat issue list. */
  viewMode: JiraBoardViewMode
  /** Sprint vs backlog tab inside the board. */
  activeView: JiraBoardActiveView
  /** Me = assigned to the viewer, All = every issue in the board filter. */
  filter: JiraBoardFilter
  /** Free-text filter applied to already-loaded board issues. */
  query: string
}

export function defaultJiraBoardViewPreferences(): JiraBoardViewPreferences {
  return {
    viewMode: 'board',
    activeView: 'sprint',
    // Why: the board opens on the viewer's own work, not the whole board filter.
    filter: 'me',
    query: ''
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMember<T extends string>(catalog: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && catalog.some((member) => member === value)
}

export function normalizeJiraBoardViewPreferences(
  value: unknown
): JiraBoardViewPreferences | undefined {
  if (!isPlainObject(value)) {
    return undefined
  }
  const next = defaultJiraBoardViewPreferences()
  if (isMember(JIRA_BOARD_VIEW_MODES, value.viewMode)) {
    next.viewMode = value.viewMode
  }
  if (isMember(JIRA_BOARD_ACTIVE_VIEWS, value.activeView)) {
    next.activeView = value.activeView
  }
  if (isMember(JIRA_BOARD_FILTERS, value.filter)) {
    next.filter = value.filter
  }
  if (typeof value.query === 'string') {
    next.query = value.query
  }
  return isDefaultJiraBoardViewPreferences(next) ? undefined : next
}

export function resolveJiraBoardViewPreferences(value: unknown): JiraBoardViewPreferences {
  return normalizeJiraBoardViewPreferences(value) ?? defaultJiraBoardViewPreferences()
}

export function isDefaultJiraBoardViewPreferences(preferences: JiraBoardViewPreferences): boolean {
  const defaults = defaultJiraBoardViewPreferences()
  return (
    preferences.viewMode === defaults.viewMode &&
    preferences.activeView === defaults.activeView &&
    preferences.filter === defaults.filter &&
    preferences.query === defaults.query
  )
}
