// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { JiraIssue } from '../../../../shared/jira-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { JiraLinkedIssuePane } from './JiraLinkedIssuePane'

const mocks = vi.hoisted(() => ({
  jiraGetIssue: vi.fn(),
  jiraIssueComments: vi.fn(),
  jiraListAssignableUsers: vi.fn(),
  jiraListEditFields: vi.fn(),
  jiraListPriorities: vi.fn(),
  jiraListTransitions: vi.fn(),
  jiraUpdateIssue: vi.fn(),
  jiraSearchUsers: vi.fn(),
  jiraAddIssueComment: vi.fn(),
  patchJiraIssue: vi.fn(),
  toastError: vi.fn(),
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
  jiraListEditFields: (...args: unknown[]) => mocks.jiraListEditFields(...args),
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
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

const linkedIssue = {
  provider: 'jira' as const,
  key: 'ABC-1',
  identifier: 'ABC-1',
  url: 'https://example.atlassian.net/browse/ABC-1',
  title: 'Fix checkout'
}

/** The workspace's own host: what the pane routes by when it has no creation-time task source. */
const PANE_OWNER_SOURCE: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'account-backed-task-source',
  hostId: 'runtime:pane-owner'
}

/** A creation-time task source on another server: the linked issue's own provider account. */
const LINKED_TASK_SOURCE = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'project-1',
  hostId: 'runtime:task-owner'
} as const

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

beforeEach(() => {
  mocks.jiraListEditFields.mockResolvedValue([])
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
        <JiraLinkedIssuePane linkedIssue={linkedIssue} sourceContext={PANE_OWNER_SOURCE} />
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
        <JiraLinkedIssuePane linkedIssue={linkedIssue} sourceContext={PANE_OWNER_SOURCE} />
      </TooltipProvider>
    )

    expect(await screen.findByText('No comments yet.')).toBeTruthy()
    // Why paste rather than a change event: the composer is a rich editor, so its
    // body arrives over the clipboard path ProseMirror actually handles.
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', 'Looks good to me')
    fireEvent.paste(screen.getByRole('textbox', { name: 'Add a Jira comment...' }), {
      clipboardData
    })
    // Why: the send action is an icon-only button, so its accessible name is the
    // only handle on it.
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))

    await waitFor(() =>
      expect(mocks.jiraAddIssueComment).toHaveBeenCalledWith(
        PANE_OWNER_SOURCE,
        'ABC-1',
        'Looks good to me',
        'site-1',
        // The host converts the composer's Markdown to the site's own format.
        'markdown'
      )
    )
    expect(await screen.findByText('Looks good to me')).toBeTruthy()
  })

  it('shows the points row for an issue whose points Jira lets this user write', async () => {
    mocks.jiraGetIssue.mockResolvedValue({ ...issue(), storyPoints: 5, storyPointsFieldId: 'cf' })
    mocks.jiraIssueComments.mockResolvedValue([])
    mocks.jiraListAssignableUsers.mockResolvedValue([])
    mocks.jiraListPriorities.mockResolvedValue([])
    mocks.jiraListTransitions.mockResolvedValue([])
    mocks.jiraListEditFields.mockResolvedValue([
      {
        field: {
          key: 'cf',
          name: 'Story Points',
          required: false,
          schema: {
            type: 'number',
            custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float'
          }
        },
        value: '5'
      }
    ])

    render(
      <TooltipProvider delayDuration={0}>
        <JiraLinkedIssuePane linkedIssue={linkedIssue} sourceContext={PANE_OWNER_SOURCE} />
      </TooltipProvider>
    )

    const row = await screen.findByRole('button', { name: /Story points/ })
    expect(row.textContent).toContain('5')
  })

  it('toasts when a status change fails from the pane', async () => {
    mocks.jiraGetIssue.mockResolvedValue(issue())
    mocks.jiraIssueComments.mockResolvedValue([])
    mocks.jiraListAssignableUsers.mockResolvedValue([])
    mocks.jiraListPriorities.mockResolvedValue([])
    mocks.jiraListTransitions.mockResolvedValue([
      {
        id: '31',
        name: 'Done',
        to: { id: '3', name: 'Done', categoryKey: 'done', categoryName: 'Done' }
      }
    ])
    mocks.jiraUpdateIssue.mockResolvedValue({ ok: false, error: 'Transition rejected' })

    render(
      <TooltipProvider delayDuration={0}>
        <JiraLinkedIssuePane linkedIssue={linkedIssue} sourceContext={PANE_OWNER_SOURCE} />
      </TooltipProvider>
    )

    const statusRow = await screen.findByRole<HTMLButtonElement>('button', {
      name: /In Progress/
    })
    // Wait for the transitions to load, which is what un-disables the row.
    await waitFor(() => expect(statusRow.disabled).toBe(false))
    fireEvent.click(statusRow)
    fireEvent.click(await screen.findByRole('button', { name: 'Done' }))

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Transition rejected'))
  })

  it('reads through the workspace owner when the link has no task source', async () => {
    mocks.jiraGetIssue.mockResolvedValue(issue())
    mocks.jiraIssueComments.mockResolvedValue([])
    mocks.jiraListAssignableUsers.mockResolvedValue([])
    mocks.jiraListPriorities.mockResolvedValue([])
    mocks.jiraListTransitions.mockResolvedValue([])

    render(
      <TooltipProvider delayDuration={0}>
        <JiraLinkedIssuePane linkedIssue={linkedIssue} sourceContext={PANE_OWNER_SOURCE} />
      </TooltipProvider>
    )

    await waitFor(() => expect(mocks.jiraGetIssue).toHaveBeenCalled())
    // Why the assertion on the transport: the linked issue's Jira account is on the workspace's
    // host, so a focused-server change must not move this read to another host's account.
    expect(mocks.jiraGetIssue).toHaveBeenCalledWith(PANE_OWNER_SOURCE, 'ABC-1', undefined)
  })

  it('prefers the creation-time task source over the workspace host', async () => {
    mocks.jiraGetIssue.mockResolvedValue(issue())
    mocks.jiraIssueComments.mockResolvedValue([])
    mocks.jiraListAssignableUsers.mockResolvedValue([])
    mocks.jiraListPriorities.mockResolvedValue([])
    mocks.jiraListTransitions.mockResolvedValue([])

    render(
      <TooltipProvider delayDuration={0}>
        <JiraLinkedIssuePane linkedIssue={linkedIssue} sourceContext={LINKED_TASK_SOURCE} />
      </TooltipProvider>
    )

    await waitFor(() => expect(mocks.jiraGetIssue).toHaveBeenCalled())
    // A workspace on another host still reads the account its task came from.
    expect(mocks.jiraGetIssue).toHaveBeenCalledWith(LINKED_TASK_SOURCE, 'ABC-1', undefined)
  })
})
