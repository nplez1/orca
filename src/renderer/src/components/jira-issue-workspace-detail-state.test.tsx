// @vitest-environment happy-dom

import React, { act } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  JiraComment,
  JiraIssue,
  JiraPriority,
  JiraTransition,
  JiraUser
} from '../../../shared/jira-types'
import { useJiraIssueWorkspaceDetail } from './jira-issue-workspace-detail-state'

const mocks = vi.hoisted(() => ({
  jiraGetIssue: vi.fn(),
  jiraIssueComments: vi.fn(),
  jiraListAssignableUsers: vi.fn(),
  jiraListPriorities: vi.fn(),
  jiraListTransitions: vi.fn(),
  jiraUpdateIssue: vi.fn(),
  patchJiraIssue: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: null, patchJiraIssue: mocks.patchJiraIssue })
}))

vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraGetIssue: (...args: unknown[]) => mocks.jiraGetIssue(...args),
  jiraIssueComments: (...args: unknown[]) => mocks.jiraIssueComments(...args),
  jiraListAssignableUsers: (...args: unknown[]) => mocks.jiraListAssignableUsers(...args),
  jiraListPriorities: (...args: unknown[]) => mocks.jiraListPriorities(...args),
  jiraListTransitions: (...args: unknown[]) => mocks.jiraListTransitions(...args),
  jiraUpdateIssue: (...args: unknown[]) => mocks.jiraUpdateIssue(...args)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback?: string) => fallback ?? _key
}))

function issue(): JiraIssue {
  return {
    id: '1001',
    key: 'ABC-1',
    siteId: 'site-1',
    title: 'Payments issue',
    url: 'https://example.atlassian.net/browse/ABC-1',
    project: { id: 'project-1', key: 'ABC', name: 'Payments' },
    issueType: { id: 'story', name: 'Story' },
    status: { id: '1', name: 'Ready', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z'
  }
}

function Probe(): React.JSX.Element {
  const detail = useJiraIssueWorkspaceDetail({
    issue: null,
    fetchKey: 'ABC-1',
    providerSettings: null
  })
  return <div data-testid="key">{detail.displayed?.key ?? 'loading'}</div>
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('useJiraIssueWorkspaceDetail with a bare fetch key', () => {
  it('hydrates and renders the issue fetched from the key alone', async () => {
    const resolved = issue()
    mocks.jiraGetIssue.mockResolvedValue(resolved)
    mocks.jiraIssueComments.mockResolvedValue([] satisfies JiraComment[])
    mocks.jiraListAssignableUsers.mockResolvedValue([] satisfies JiraUser[])
    mocks.jiraListPriorities.mockResolvedValue([] satisfies JiraPriority[])
    mocks.jiraListTransitions.mockResolvedValue([] satisfies JiraTransition[])

    render(<Probe />)

    await waitFor(() => expect(screen.getByTestId('key').textContent).toBe('ABC-1'))
    expect(mocks.jiraGetIssue).toHaveBeenCalledWith(null, 'ABC-1', undefined)
  })

  it('keeps the fetched issue when the side-data load advances its own request', async () => {
    const resolved = issue()
    mocks.jiraGetIssue.mockResolvedValue(resolved)
    mocks.jiraIssueComments.mockResolvedValue([] satisfies JiraComment[])
    mocks.jiraListAssignableUsers.mockResolvedValue([] satisfies JiraUser[])
    mocks.jiraListPriorities.mockResolvedValue([] satisfies JiraPriority[])
    mocks.jiraListTransitions.mockResolvedValue([] satisfies JiraTransition[])

    render(<Probe />)

    // The side-data effect increments its own request id once the issue hydrates;
    // the fetched issue must not be discarded by that increment.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getByTestId('key').textContent).toBe('ABC-1'))
  })
})
