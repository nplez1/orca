// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JiraConnectionStatus, JiraIssue, JiraUser } from '../../../shared/jira-types'
import { buildJiraIssueWorkspaceAttachmentIndex } from '@/lib/jira-issue-workspace-attachment'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import JiraIssueWorkspace from './JiraIssueWorkspace'

const mocks = vi.hoisted(() => {
  const storeState: { jiraStatus: JiraConnectionStatus | undefined } = { jiraStatus: undefined }
  return {
    jiraGetIssue: vi.fn(),
    jiraIssueComments: vi.fn(),
    jiraListAssignableUsers: vi.fn(),
    jiraListPriorities: vi.fn(),
    jiraListTransitions: vi.fn(),
    jiraUpdateIssue: vi.fn(),
    jiraAddIssueComment: vi.fn(),
    patchJiraIssue: vi.fn(),
    storeState
  }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      settings: null,
      patchJiraIssue: mocks.patchJiraIssue,
      jiraStatus: mocks.storeState.jiraStatus
    })
}))

vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraGetIssue: (...args: unknown[]) => mocks.jiraGetIssue(...args),
  jiraIssueComments: (...args: unknown[]) => mocks.jiraIssueComments(...args),
  jiraListAssignableUsers: (...args: unknown[]) => mocks.jiraListAssignableUsers(...args),
  jiraListPriorities: (...args: unknown[]) => mocks.jiraListPriorities(...args),
  jiraListTransitions: (...args: unknown[]) => mocks.jiraListTransitions(...args),
  jiraListEditFields: async () => [],
  jiraUpdateIssue: (...args: unknown[]) => mocks.jiraUpdateIssue(...args),
  jiraAddIssueComment: (...args: unknown[]) => mocks.jiraAddIssueComment(...args)
}))

vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  SheetContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('./jira-issue-workspace-chrome', () => ({
  JiraIssueMetadataBar: ({
    displayed,
    selfUser
  }: {
    displayed: JiraIssue
    selfUser: JiraUser | null
  }) => (
    <div>
      <div data-testid="issue-status">{displayed.status.name}</div>
      <div data-testid="assignee-self">{selfUser?.accountId ?? ''}</div>
    </div>
  ),
  JiraIssueWorkspaceHeader: () => null
}))

vi.mock('./jira-issue-workspace-content', () => ({
  JiraIssueCommentComposer: () => null,
  JiraIssueWorkspaceContent: () => null
}))

vi.mock('./jira-issue-workspace-actions', () => ({
  getJiraIssueWorkspaceActions: () => []
}))

function issue(statusId: string, statusName: string): JiraIssue {
  return {
    id: '1001',
    key: 'ABC-1',
    siteId: 'site-1',
    title: 'Payments issue',
    url: 'https://example.atlassian.net/browse/ABC-1',
    project: { id: 'project-1', key: 'ABC', name: 'Payments' },
    issueType: { id: 'story', name: 'Story' },
    status: { id: statusId, name: statusName, categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z'
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.storeState.jiraStatus = undefined
})

const EMPTY_ATTACHMENT_INDEX = buildJiraIssueWorkspaceAttachmentIndex([])

/** The issue's own source, so the pane's reads and patches route by its owner. */
const REFRESH_SOURCE: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'refresh-project',
  hostId: 'local'
}

describe('JiraIssueWorkspace refresh signal', () => {
  it('refreshes the selected issue after a board transition without replacing the selection', async () => {
    const selectedIssue = issue('1', 'Ready')
    const movedIssue = issue('3', 'In Progress')
    mocks.jiraGetIssue.mockResolvedValueOnce(selectedIssue).mockResolvedValueOnce(movedIssue)
    mocks.jiraIssueComments.mockResolvedValue([])
    mocks.jiraListAssignableUsers.mockResolvedValue([])
    mocks.jiraListPriorities.mockResolvedValue([])
    mocks.jiraListTransitions.mockResolvedValue([])

    const onUse = vi.fn()
    const onClose = vi.fn()
    const view = render(
      <JiraIssueWorkspace
        issue={selectedIssue}
        issueWorkspaceAttachmentIndex={EMPTY_ATTACHMENT_INDEX}
        onUse={onUse}
        onClose={onClose}
        sourceContext={REFRESH_SOURCE}
        refreshSignal={0}
      />
    )

    await waitFor(() => expect(screen.getByTestId('issue-status').textContent).toBe('Ready'))
    view.rerender(
      <JiraIssueWorkspace
        issue={selectedIssue}
        issueWorkspaceAttachmentIndex={EMPTY_ATTACHMENT_INDEX}
        onUse={onUse}
        onClose={onClose}
        sourceContext={REFRESH_SOURCE}
        refreshSignal={1}
      />
    )

    await waitFor(() => expect(screen.getByTestId('issue-status').textContent).toBe('In Progress'))
    expect(onClose).not.toHaveBeenCalled()
    expect(onUse).not.toHaveBeenCalled()
    expect(mocks.patchJiraIssue).toHaveBeenCalledWith('ABC-1', movedIssue, {
      sourceContext: REFRESH_SOURCE
    })
  })

  it("pins the signed-in user for the issue's site into the assignee picker", async () => {
    mocks.storeState.jiraStatus = {
      connected: true,
      activeSiteId: 'site-1',
      viewer: { accountId: 'viewer-1', displayName: 'Viewer One', email: null }
    }
    const selectedIssue = issue('1', 'Ready')
    mocks.jiraGetIssue.mockResolvedValue(selectedIssue)
    mocks.jiraIssueComments.mockResolvedValue([])
    mocks.jiraListAssignableUsers.mockResolvedValue([])
    mocks.jiraListPriorities.mockResolvedValue([])
    mocks.jiraListTransitions.mockResolvedValue([])

    render(
      <JiraIssueWorkspace
        issue={selectedIssue}
        issueWorkspaceAttachmentIndex={EMPTY_ATTACHMENT_INDEX}
        onUse={vi.fn()}
        onClose={vi.fn()}
        refreshSignal={0}
        sourceContext={REFRESH_SOURCE}
      />
    )

    await waitFor(() => expect(screen.getByTestId('assignee-self').textContent).toBe('viewer-1'))
  })
})
