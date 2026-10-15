// @vitest-environment happy-dom

import React, { act } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import type {
  JiraComment,
  JiraIssue,
  JiraPriority,
  JiraSprintAssignment,
  JiraTransition,
  JiraUser
} from '../../../shared/jira-types'
import { defaultScopeSource } from '@/lib/default-creation-host'
import { useJiraIssueWorkspaceDetail } from './jira-issue-workspace-detail-state'

const mocks = vi.hoisted(() => ({
  jiraGetIssue: vi.fn(),
  jiraGetIssueSprintAssignment: vi.fn(),
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
  jiraGetIssueSprintAssignment: (...args: unknown[]) => mocks.jiraGetIssueSprintAssignment(...args),
  jiraIssueComments: (...args: unknown[]) => mocks.jiraIssueComments(...args),
  jiraListAssignableUsers: (...args: unknown[]) => mocks.jiraListAssignableUsers(...args),
  jiraListPriorities: (...args: unknown[]) => mocks.jiraListPriorities(...args),
  jiraListTransitions: (...args: unknown[]) => mocks.jiraListTransitions(...args),
  jiraListEditFields: async () => [],
  jiraUpdateIssue: (...args: unknown[]) => mocks.jiraUpdateIssue(...args)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback?: string) => fallback ?? _key
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() } }))

function issue(key = 'ABC-1'): JiraIssue {
  return {
    id: '1001',
    key,
    siteId: 'site-1',
    title: 'Payments issue',
    url: `https://example.atlassian.net/browse/${key}`,
    project: { id: 'project-1', key: 'ABC', name: 'Payments' },
    issueType: { id: 'story', name: 'Story' },
    status: { id: '1', name: 'Ready', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z'
  }
}

// Why the cache: the detail hook keys its fetch effect on the issue object, so a
// fresh fixture per render would refetch forever.
const issuesByKey = new Map<string, JiraIssue>()
function issueFor(key: string): JiraIssue {
  const cached = issuesByKey.get(key)
  if (cached) {
    return cached
  }
  const created = issue(key)
  issuesByKey.set(key, created)
  return created
}

// Stable per site for the same reason as `issueFor`.
const sprintBoardsBySite = new Map<string, { boardId: string; siteId: string }>()
function sprintBoardFor(siteId: string): { boardId: string; siteId: string } {
  const cached = sprintBoardsBySite.get(siteId)
  if (cached) {
    return cached
  }
  const created = { boardId: '42', siteId }
  sprintBoardsBySite.set(siteId, created)
  return created
}

const DEFAULT_SCOPE_SOURCE = defaultScopeSource(null)

function Probe(): React.JSX.Element {
  const detail = useJiraIssueWorkspaceDetail({
    issue: null,
    fetchKey: 'ABC-1',
    providerSettings: DEFAULT_SCOPE_SOURCE
  })
  return <div data-testid="key">{detail.displayed?.key ?? 'loading'}</div>
}

const sprintAssignment: JiraSprintAssignment = {
  sprint: { id: '87', name: 'September sprint', state: 'active' },
  sprints: [
    { id: '87', name: 'September sprint', state: 'active' },
    { id: '88', name: 'October sprint', state: 'future' }
  ]
}

/** Renders the sprint assignment and drives one move, so the hook's read, its
 *  optimistic patch, its rollback, and its reload are all observable. */
function SprintProbe({
  issueKey = 'ABC-1',
  boardSiteId = 'site-1'
}: {
  issueKey?: string
  boardSiteId?: string
} = {}): React.JSX.Element {
  const detail = useJiraIssueWorkspaceDetail({
    issue: issueFor(issueKey),
    sprintBoard: sprintBoardFor(boardSiteId),
    providerSettings: DEFAULT_SCOPE_SOURCE
  })
  return (
    <div>
      <div data-testid="sprint">{detail.sprintAssignment?.sprint?.name ?? 'none'}</div>
      <button type="button" onClick={() => void detail.mutateIssue('sprint', { sprintId: '88' })}>
        move
      </button>
    </div>
  )
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
    expect(mocks.jiraGetIssue).toHaveBeenCalledWith(DEFAULT_SCOPE_SOURCE, 'ABC-1', undefined)
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

describe('useJiraIssueWorkspaceDetail sprint assignment', () => {
  it('reads the issue assignment for the board in scope and reloads it after a move', async () => {
    mocks.jiraGetIssue.mockResolvedValue(issue())
    mocks.jiraIssueComments.mockResolvedValue([] satisfies JiraComment[])
    mocks.jiraListAssignableUsers.mockResolvedValue([] satisfies JiraUser[])
    mocks.jiraListPriorities.mockResolvedValue([] satisfies JiraPriority[])
    mocks.jiraListTransitions.mockResolvedValue([] satisfies JiraTransition[])
    mocks.jiraGetIssueSprintAssignment.mockResolvedValue(sprintAssignment)
    mocks.jiraUpdateIssue.mockResolvedValue({ ok: true })
    const user = userEvent.setup()

    render(<SprintProbe />)
    await waitFor(() => expect(screen.getByTestId('sprint').textContent).toBe('September sprint'))
    expect(mocks.jiraGetIssueSprintAssignment).toHaveBeenCalledWith(
      DEFAULT_SCOPE_SOURCE,
      'ABC-1',
      'site-1',
      '42'
    )

    await user.click(screen.getByRole('button', { name: 'move' }))

    await waitFor(() =>
      expect(mocks.jiraUpdateIssue).toHaveBeenCalledWith(
        DEFAULT_SCOPE_SOURCE,
        'ABC-1',
        { sprintId: '88' },
        'site-1'
      )
    )
    // The issue read does not carry the sprint, so the assignment is re-read.
    await waitFor(() => expect(mocks.jiraGetIssueSprintAssignment).toHaveBeenCalledTimes(2))
  })

  it('puts the previous sprint back when the move fails and the re-read cannot answer', async () => {
    mocks.jiraGetIssue.mockResolvedValue(issue())
    mocks.jiraIssueComments.mockResolvedValue([] satisfies JiraComment[])
    mocks.jiraListAssignableUsers.mockResolvedValue([] satisfies JiraUser[])
    mocks.jiraListPriorities.mockResolvedValue([] satisfies JiraPriority[])
    mocks.jiraListTransitions.mockResolvedValue([] satisfies JiraTransition[])
    mocks.jiraGetIssueSprintAssignment.mockResolvedValue(sprintAssignment)
    const user = userEvent.setup()

    render(<SprintProbe />)
    await waitFor(() => expect(screen.getByTestId('sprint').textContent).toBe('September sprint'))

    // Why: the fault that fails the move usually fails the re-read too, so the
    // rollback cannot depend on it answering.
    mocks.jiraUpdateIssue.mockResolvedValue({ ok: false, error: 'Sprint is closed' })
    mocks.jiraGetIssueSprintAssignment.mockResolvedValue(null)
    await user.click(screen.getByRole('button', { name: 'move' }))

    await waitFor(() => expect(screen.getByTestId('sprint').textContent).toBe('September sprint'))
  })

  it('does not show the previous issue sprint while the next read is in flight', async () => {
    mocks.jiraGetIssue.mockImplementation((_settings: unknown, key: string) =>
      Promise.resolve(issue(key))
    )
    mocks.jiraIssueComments.mockResolvedValue([] satisfies JiraComment[])
    mocks.jiraListAssignableUsers.mockResolvedValue([] satisfies JiraUser[])
    mocks.jiraListPriorities.mockResolvedValue([] satisfies JiraPriority[])
    mocks.jiraListTransitions.mockResolvedValue([] satisfies JiraTransition[])
    mocks.jiraGetIssueSprintAssignment.mockResolvedValue(sprintAssignment)

    const view = render(<SprintProbe />)
    await waitFor(() => expect(screen.getByTestId('sprint').textContent).toBe('September sprint'))

    mocks.jiraGetIssueSprintAssignment.mockReturnValue(new Promise<never>(() => {}))
    view.rerender(<SprintProbe issueKey="ABC-2" />)

    expect(screen.getByTestId('sprint').textContent).toBe('none')
  })

  it('reads no board for an issue that belongs to another site', async () => {
    mocks.jiraGetIssue.mockResolvedValue(issue())
    mocks.jiraIssueComments.mockResolvedValue([] satisfies JiraComment[])
    mocks.jiraListAssignableUsers.mockResolvedValue([] satisfies JiraUser[])
    mocks.jiraListPriorities.mockResolvedValue([] satisfies JiraPriority[])
    mocks.jiraListTransitions.mockResolvedValue([] satisfies JiraTransition[])

    render(<SprintProbe boardSiteId="site-2" />)

    await waitFor(() => expect(mocks.jiraGetIssue).toHaveBeenCalled())
    expect(mocks.jiraGetIssueSprintAssignment).not.toHaveBeenCalled()
  })
})
