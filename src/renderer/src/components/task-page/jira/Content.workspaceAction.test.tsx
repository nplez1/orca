// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { JiraIssue } from '../../../../../shared/jira/jira-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { buildJiraIssueWorkspaceAttachmentIndex } from '@/lib/jira-issue-workspace-attachment'
import { openJiraIssueWorkspace } from '@/lib/jira-issue-workspace-open'
import { defaultJiraListColumnIds, visibleJiraListColumns } from '../../jira-list-columns'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'

// Why: this pins the seam the helper tests cannot see — which handler Content wires
// the list and the sheet to. A revert to the composer-opening handler would keep every
// other test green.
const spies = vi.hoisted(() => ({
  list: vi.fn(),
  sheet: vi.fn()
}))

vi.mock('@/components/task-page-jira-issue-list', () => ({
  TaskPageJiraIssueList: (props: {
    onOpenOrStartWorkspace: unknown
    issueWorkspaceAttachmentIndex: unknown
    sourceContext: unknown
    columns: unknown
    getIssueWorkspaces: unknown
    onOpenWorkspace: unknown
    onStartWorkspace: unknown
  }) => {
    spies.list(
      props.onOpenOrStartWorkspace,
      props.issueWorkspaceAttachmentIndex,
      props.sourceContext,
      props.columns,
      props.getIssueWorkspaces,
      props.onOpenWorkspace,
      props.onStartWorkspace
    )
    return null
  }
}))

vi.mock('@/components/JiraIssueWorkspace', () => ({
  default: (props: { issueWorkspaceAttachmentIndex: unknown; onUse: unknown }) => {
    spies.sheet(props.onUse, props.issueWorkspaceAttachmentIndex)
    return null
  }
}))

vi.mock('./Board', () => ({ TaskPageJiraBoard: () => null }))
vi.mock('../linear/Content', () => ({ TaskPageLinearContent: () => null }))
// Presentation chrome the list branch renders; the test only pins the handler wiring.
vi.mock('@/components/jira-list-columns-menu', () => ({ JiraListColumnsMenu: () => null }))
vi.mock('@/components/task-page-jira-view-controls', () => ({
  TaskPageJiraViewControls: () => null
}))
vi.mock('@/components/task-page-jira-sort-controls', () => ({
  TaskPageJiraSortControls: () => null
}))

import { TooltipProvider } from '@/components/ui/tooltip'

import { TaskPageJiraContent } from './Content'

function issue(): JiraIssue {
  return {
    id: '1001',
    key: 'ALP-1',
    siteId: 'site-1',
    siteName: 'Example Jira',
    title: 'Payments issue',
    url: 'https://example.atlassian.net/browse/ALP-1',
    project: { id: 'project-1', key: 'ALP', name: 'Payments' },
    issueType: { id: 'story', name: 'Story' },
    status: { id: '1', name: 'To Do', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z'
  }
}

function attachedWorkspace(displayName: string): Worktree {
  return {
    id: 'wt-attached',
    repoId: 'repo-1',
    path: '/tmp/repo-1/wt-attached',
    head: 'abc123',
    branch: 'refs/heads/alp-1-fix-payments',
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
      title: 'ALP-1',
      url: 'https://example.atlassian.net/browse/ALP-1',
      jiraIdentifier: 'ALP-1'
    },
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

function model(
  workspaces: Worktree[],
  view: 'list' | 'board' = 'list'
): {
  handleUseJiraItem: (issue: JiraIssue) => void
  handleOpenOrUseJiraItem: (issue: JiraIssue) => void
  getJiraIssueWorkspaces: (issue: JiraIssue) => readonly Worktree[]
  composerHandler: (issue: JiraIssue) => void
  rendered: TaskPageComposerActionsModel
} {
  const handleUseJiraItem = vi.fn()
  const handleOpenOrUseJiraItem = vi.fn()
  const getJiraIssueWorkspaces = vi.fn(() => [])
  const composerHandler = vi.fn()
  const selectedIssue = issue()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: TaskPage accumulates one model object across hooks; the test supplies only the members this component reads.
  const rendered = {
    settings: view === 'board' ? { defaultJiraBoard: { siteId: 'site-1', boardId: '42' } } : null,
    jiraStatus: { credentialError: null },
    jiraStatusReady: true,
    jiraBoardViewMode: view,
    setJiraBoardViewMode: vi.fn(),
    jiraViewMode: 'list',
    setJiraViewMode: vi.fn(),
    jiraCurrentSprint: false,
    setJiraCurrentSprint: vi.fn(),
    jiraHasWorkspace: false,
    getJiraIssueWorkspaces,
    jiraConnected: true,
    selectedJiraSiteId: 'site-1',
    hideTaskSource: vi.fn(),
    taskSource: 'jira',
    closeTaskDetailPage: vi.fn(),
    selectedJiraIssue: selectedIssue,
    jiraDetailSourceContext: null,
    jiraTaskSourceContext: null,
    openJiraDetailPage: vi.fn(),
    jiraIssues: [selectedIssue],
    jiraLoading: false,
    jiraError: null,
    jiraErrorDetailsOpen: false,
    setJiraErrorDetailsOpen: vi.fn(),
    jiraJqlRejection: null,
    jiraSearchInput: '',
    jiraOrderBy: 'status',
    jiraOrderDirection: 'asc',
    handleJiraSort: vi.fn(),
    jiraColumnIds: defaultJiraListColumnIds(),
    jiraColumns: visibleJiraListColumns(defaultJiraListColumnIds()),
    toggleJiraColumn: vi.fn(),
    displayedJiraIssues: [selectedIssue],
    displayedJiraStatusOrder: null,
    sortedJiraIssues: [selectedIssue],
    setJiraConnectOpen: vi.fn(),
    jiraIssueAttachmentIndex: buildJiraIssueWorkspaceAttachmentIndex(workspaces),
    handleUseJiraItem,
    handleOpenOrUseJiraItem,
    // Why supplied at all: it must not be the handler either surface is wired to.
    composerHandler
  } as unknown as TaskPageComposerActionsModel
  return {
    handleUseJiraItem,
    handleOpenOrUseJiraItem,
    getJiraIssueWorkspaces,
    composerHandler,
    rendered
  }
}

afterEach(() => {
  cleanup()
  spies.list.mockReset()
  spies.sheet.mockReset()
})

describe('TaskPageJiraContent workspace action wiring', () => {
  it('wires the list chip and the sheet to open-or-start, never the composer', () => {
    const {
      handleUseJiraItem,
      handleOpenOrUseJiraItem,
      getJiraIssueWorkspaces,
      composerHandler,
      rendered
    } = model([attachedWorkspace('alp-1-fix-payments')])

    render(
      <TooltipProvider>
        <TaskPageJiraContent model={rendered} />
      </TooltipProvider>
    )

    expect(spies.list).toHaveBeenCalledWith(
      handleOpenOrUseJiraItem,
      rendered.jiraIssueAttachmentIndex,
      rendered.jiraTaskSourceContext,
      rendered.jiraColumns,
      getJiraIssueWorkspaces,
      openJiraIssueWorkspace,
      handleUseJiraItem
    )
    expect(spies.sheet).toHaveBeenCalledWith(
      handleOpenOrUseJiraItem,
      rendered.jiraIssueAttachmentIndex
    )
    expect(spies.list).not.toHaveBeenCalledWith(
      composerHandler,
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
    expect(spies.sheet).not.toHaveBeenCalledWith(composerHandler, expect.anything())
    // The chip and open/start must not be wired to the start-only (composer) handler.
    expect(handleUseJiraItem).not.toHaveBeenCalled()
  })

  it('routes the sheet the same way in board mode', () => {
    const { handleOpenOrUseJiraItem, composerHandler, rendered } = model(
      [attachedWorkspace('alp-1-fix-payments')],
      'board'
    )

    render(
      <TooltipProvider>
        <TaskPageJiraContent model={rendered} />
      </TooltipProvider>
    )

    // Board mode renders no list, and its own copy of the sheet.
    expect(spies.list).not.toHaveBeenCalled()
    expect(spies.sheet).toHaveBeenCalledWith(
      handleOpenOrUseJiraItem,
      rendered.jiraIssueAttachmentIndex
    )
    expect(spies.sheet).not.toHaveBeenCalledWith(composerHandler, expect.anything())
  })
})
