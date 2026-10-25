// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JiraIssue } from '../../../shared/jira/jira-types'
import { JiraIssueCell } from './task-page-jira-issue-cells'

function issue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: '1001',
    key: 'ABC-1',
    title: 'Payments issue',
    url: 'https://example.atlassian.net/browse/ABC-1',
    project: { id: 'project-1', key: 'ABC', name: 'Payments' },
    issueType: { id: 'story', name: 'Story' },
    status: { id: '1', name: 'Ready', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    ...overrides
  }
}

function renderCell(column: 'storyPoints' | 'sprint', displayed: JiraIssue): void {
  render(
    <JiraIssueCell
      column={column}
      issue={displayed}
      formatUpdatedAt={vi.fn(() => 'now')}
      getStatusTone={vi.fn(() => '')}
    />
  )
}

afterEach(cleanup)

describe('JiraIssueCell planning columns', () => {
  it('shows the story points the issue holds', () => {
    renderCell('storyPoints', issue({ storyPoints: 5 }))

    expect(screen.getByText('5')).toBeTruthy()
  })

  it('reads as unset for an issue with no story points', () => {
    renderCell('storyPoints', issue())

    expect(screen.getByText('–')).toBeTruthy()
  })

  it('shows the sprint when Jira resolved one', () => {
    renderCell('sprint', issue({ sprint: 'Sprint 12' }))

    expect(screen.getByText('Sprint 12')).toBeTruthy()
  })
})
