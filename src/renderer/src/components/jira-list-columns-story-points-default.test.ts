// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import {
  JIRA_LIST_COLUMNS,
  defaultJiraListColumnIds,
  resolveJiraListColumnIds,
  visibleJiraListColumns
} from './jira-list-columns'

describe('Jira list column defaults (fork)', () => {
  // Why this diverges from upstream, which hides every planning column: a scrum
  // board is planned by points, so the fork shows them without the column picker.
  it('shows story points by default and leaves the other planning fields hidden', () => {
    expect([...defaultJiraListColumnIds()]).toEqual([
      'key',
      'title',
      'status',
      'priority',
      'assignee',
      'storyPoints',
      'updated'
    ])
    expect(visibleJiraListColumns(defaultJiraListColumnIds()).map((column) => column.id)).toContain(
      'storyPoints'
    )
  })

  it('keeps story points a default rather than a locked column', () => {
    // A saved choice that omits points must win, otherwise the divergence above would
    // be an unremovable column rather than a different default.
    expect(resolveJiraListColumnIds(['key', 'title', 'updated']).has('storyPoints')).toBe(false)
    expect(JIRA_LIST_COLUMNS.find((column) => column.id === 'storyPoints')?.locked).toBeUndefined()
  })
})
