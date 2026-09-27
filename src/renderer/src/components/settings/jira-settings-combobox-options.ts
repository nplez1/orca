import type { JiraBoard, JiraBoardSelection, JiraField } from '../../../../shared/jira-types'
import type { SettingsComboboxOption } from './SettingsCombobox'

export function boardOptionValue(board: Pick<JiraBoard, 'siteId' | 'id'>): string {
  return `${encodeURIComponent(board.siteId)}:${encodeURIComponent(board.id)}`
}

export function boardSelectionOptionValue(
  selection: Pick<JiraBoardSelection, 'siteId' | 'boardId'>
): string {
  return `${encodeURIComponent(selection.siteId)}:${encodeURIComponent(selection.boardId)}`
}

/**
 * Why the saved board is kept: a large Jira site returns only the first page (or the
 * read failed), and the picker still has to name the setting it is showing.
 */
export function buildJiraBoardOptions(
  boards: JiraBoard[],
  selected: JiraBoardSelection | null,
  unnamedSelectedBoardLabel: string
): SettingsComboboxOption[] {
  const spansSites = new Set(boards.map((board) => board.siteId)).size > 1
  const options = boards.map((board) => ({
    value: boardOptionValue(board),
    label: spansSites ? `${board.name} · ${board.siteName}` : board.name
  }))
  if (selected) {
    const value = boardSelectionOptionValue(selected)
    if (!options.some((option) => option.value === value)) {
      options.unshift({
        value,
        label: selected.name?.trim() || unnamedSelectedBoardLabel
      })
    }
  }
  return options
}

export function buildJiraTeamFieldOptions(
  fields: JiraField[],
  query: string,
  showSiteNames: boolean
): SettingsComboboxOption[] {
  const normalized = query.trim().toLowerCase()
  const matches = normalized
    ? fields.filter((field) => `${field.name} ${field.id}`.toLowerCase().includes(normalized))
    : fields
  // Why: with every site selected the same field id can arrive from two sites; the
  // setting stores a single id, so keep the first and avoid duplicate option values.
  const byId = new Map<string, JiraField>()
  for (const field of matches) {
    if (!byId.has(field.id)) {
      byId.set(field.id, field)
    }
  }
  return [...byId.values()].map((field) => ({
    value: field.id,
    label: showSiteNames
      ? `${field.name} (${field.id}) · ${field.siteName}`
      : `${field.name} (${field.id})`
  }))
}
