// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import type { ReactNode } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildJiraIssueWorkspaceAttachmentIndex } from '@/lib/jira-issue-workspace-attachment'
import type { JiraIssue } from '../../../shared/jira-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { TaskSourceContext } from '../../../shared/task-source-context'

const state = vi.hoisted(() => {
  const holder: { displayed: JiraIssue | null } = { displayed: null }
  return holder
})
const spies = vi.hoisted(() => ({ header: vi.fn(), content: vi.fn() }))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: { settings: null }) => unknown) => selector({ settings: null })
}))

// Why: the detail hook is what holds the stale issue for a render after the selection
// changes, which is the case the label has to follow.
vi.mock('./jira-issue-workspace-detail-state', () => ({
  useJiraIssueWorkspaceDetail: () => ({ displayed: state.displayed, issueLoading: false })
}))

vi.mock('./jira-issue-workspace-chrome', () => ({
  JiraIssueWorkspaceHeader: (props: { attachedWorkspaceLabel: string | null }) => {
    spies.header(props.attachedWorkspaceLabel)
    return null
  },
  JiraIssueMetadataBar: () => null
}))

vi.mock('./jira-issue-workspace-content', () => ({
  JiraIssueWorkspaceContent: (props: { attachedWorkspaceLabel: string | null }) => {
    spies.content(props.attachedWorkspaceLabel)
    return null
  },
  JiraIssueCommentComposer: () => null
}))

vi.mock('./jira-issue-workspace-actions', () => ({ getJiraIssueWorkspaceActions: () => [] }))

vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  SheetContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

import JiraIssueWorkspace from './JiraIssueWorkspace'

function issue(key: string): JiraIssue {
  return {
    id: key,
    key,
    siteId: 'site-1',
    title: `${key} title`,
    url: `https://example.atlassian.net/browse/${key}`,
    project: { id: 'project-1', key: 'ALP', name: 'Payments' },
    issueType: { id: 'story', name: 'Story' },
    status: { id: '1', name: 'To Do', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z'
  }
}

function attachedWorkspace(key: string, displayName: string): Worktree {
  return {
    id: `wt-${key}`,
    repoId: 'repo-1',
    path: `/tmp/repo-1/wt-${key}`,
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedWorkItem: {
      provider: 'jira',
      type: 'issue',
      number: 0,
      title: key,
      url: `https://example.atlassian.net/browse/${key}`,
      jiraIdentifier: key
    },
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

const attachmentIndex = buildJiraIssueWorkspaceAttachmentIndex([
  attachedWorkspace('ALP-1', 'alp-1-fix-payments')
])

const SHEET_SOURCE: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'sheet-project',
  hostId: 'local'
}

function renderSheet(selectedIssue: JiraIssue): void {
  render(
    <JiraIssueWorkspace
      issue={selectedIssue}
      issueWorkspaceAttachmentIndex={attachmentIndex}
      onOpenOrStartWorkspace={vi.fn()}
      onClose={vi.fn()}
      sourceContext={SHEET_SOURCE}
    />
  )
}

afterEach(() => {
  cleanup()
  spies.header.mockReset()
  spies.content.mockReset()
  state.displayed = null
})

describe('Jira issue workspace attached label', () => {
  it('labels both actions with the workspace attached to the issue they would send', () => {
    state.displayed = issue('ALP-1')

    renderSheet(issue('ALP-1'))

    expect(spies.header).toHaveBeenCalledWith('alp-1-fix-payments')
    expect(spies.content).toHaveBeenCalledWith('alp-1-fix-payments')
  })

  it('follows the displayed issue rather than the newly selected one', () => {
    // The selection moved to ALP-2 but the sheet still shows ALP-1 for this render, and
    // a click would send ALP-1 — so the label must describe ALP-1 too.
    state.displayed = issue('ALP-1')

    renderSheet(issue('ALP-2'))

    expect(spies.header).toHaveBeenCalledWith('alp-1-fix-payments')
    expect(spies.content).toHaveBeenCalledWith('alp-1-fix-payments')
  })

  it('labels neither action when the displayed issue has no workspace', () => {
    state.displayed = issue('ALP-2')

    renderSheet(issue('ALP-1'))

    expect(spies.header).toHaveBeenCalledWith(null)
    expect(spies.content).toHaveBeenCalledWith(null)
  })
})
