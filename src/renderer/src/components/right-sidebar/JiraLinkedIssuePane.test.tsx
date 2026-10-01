// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { JiraIssue } from '../../../../shared/jira-types'
import { JiraLinkedIssuePane } from './JiraLinkedIssuePane'

const mocks = vi.hoisted(() => ({
  jiraGetIssue: vi.fn(),
  jiraIssueComments: vi.fn(),
  jiraListAssignableUsers: vi.fn(),
  jiraListPriorities: vi.fn(),
  jiraListTransitions: vi.fn(),
  jiraUpdateIssue: vi.fn(),
  jiraSearchUsers: vi.fn(),
  jiraAddIssueComment: vi.fn(),
  patchJiraIssue: vi.fn(),
  viewerAccountId: 'u-bob'
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      settings: null,
      patchJiraIssue: mocks.patchJiraIssue,
      jiraStatus: { viewer: { accountId: mocks.viewerAccountId, displayName: 'Bob' } }
    })
}))

vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraGetIssue: (...args: unknown[]) => mocks.jiraGetIssue(...args),
  jiraIssueComments: (...args: unknown[]) => mocks.jiraIssueComments(...args),
  jiraListAssignableUsers: (...args: unknown[]) => mocks.jiraListAssignableUsers(...args),
  jiraListPriorities: (...args: unknown[]) => mocks.jiraListPriorities(...args),
  jiraListTransitions: (...args: unknown[]) => mocks.jiraListTransitions(...args),
  jiraUpdateIssue: (...args: unknown[]) => mocks.jiraUpdateIssue(...args),
  jiraSearchUsers: (...args: unknown[]) => mocks.jiraSearchUsers(...args),
  jiraAddIssueComment: (...args: unknown[]) => mocks.jiraAddIssueComment(...args)
}))

vi.mock('@/components/sidebar/CommentMarkdown', () => ({
  default: ({ content }: { content: string }) => <div>{content}</div>
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback?: string) => fallback ?? _key
}))
vi.mock('@/i18n/relative-time-format', () => ({
  formatUiRelativeTimeFromDate: () => 'now'
}))

const linkedIssue = {
  provider: 'jira' as const,
  key: 'ABC-1',
  identifier: 'ABC-1',
  url: 'https://example.atlassian.net/browse/ABC-1',
  title: 'Fix checkout'
}

function issue(): JiraIssue {
  return {
    id: '1001',
    key: 'ABC-1',
    siteId: 'site-1',
    title: 'Fix checkout',
    url: 'https://example.atlassian.net/browse/ABC-1',
    project: { id: 'project-1', key: 'ABC', name: 'Payments' },
    issueType: { id: 'story', name: 'Story' },
    status: {
      id: '2',
      name: 'In Progress',
      categoryKey: 'indeterminate',
      categoryName: 'In Progress'
    },
    priority: { id: 'p1', name: 'Blocker' },
    assignee: { accountId: 'u-bob', displayName: 'Bob' },
    labels: ['bug', 'ui'],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z'
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('JiraLinkedIssuePane', () => {
  it('renders the compact property rows with the issue values', async () => {
    mocks.jiraGetIssue.mockResolvedValue(issue())
    mocks.jiraIssueComments.mockResolvedValue([])
    mocks.jiraListAssignableUsers.mockResolvedValue([
      { accountId: 'u-alice', displayName: 'Alice' },
      { accountId: 'u-bob', displayName: 'Bob' }
    ])
    mocks.jiraListPriorities.mockResolvedValue([{ id: 'p1', name: 'Blocker' }])
    mocks.jiraListTransitions.mockResolvedValue([])

    render(
      <TooltipProvider delayDuration={0}>
        <JiraLinkedIssuePane linkedIssue={linkedIssue} sourceContext={null} />
      </TooltipProvider>
    )

    expect(await screen.findByText('In Progress')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Assignee, Bob' })).toBeTruthy()
    expect(screen.getByText('Blocker')).toBeTruthy()
    expect(screen.getByText('bug, ui')).toBeTruthy()
    expect(screen.getByLabelText('Issue title')).toBeTruthy()
  })

  it('posts a comment and shows it in the thread', async () => {
    mocks.jiraGetIssue.mockResolvedValue(issue())
    mocks.jiraIssueComments.mockResolvedValue([])
    mocks.jiraListAssignableUsers.mockResolvedValue([])
    mocks.jiraListPriorities.mockResolvedValue([])
    mocks.jiraListTransitions.mockResolvedValue([])
    mocks.jiraAddIssueComment.mockResolvedValue({ ok: true, id: 'c1' })

    render(
      <TooltipProvider delayDuration={0}>
        <JiraLinkedIssuePane linkedIssue={linkedIssue} sourceContext={null} />
      </TooltipProvider>
    )

    expect(await screen.findByText('No comments yet.')).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('Add a Jira comment...'), {
      target: { value: 'Looks good to me' }
    })
    fireEvent.click(screen.getByText('Comment'))

    await waitFor(() =>
      expect(mocks.jiraAddIssueComment).toHaveBeenCalledWith(
        null,
        'ABC-1',
        'Looks good to me',
        'site-1'
      )
    )
    expect(await screen.findByText('Looks good to me')).toBeTruthy()
  })
})
