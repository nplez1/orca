// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'

import { createGlobalSettingsFixture } from '../../../../../shared/global-settings-test-fixture'
import type { JiraBoardIssuePageRequest, JiraIssue } from '../../../../../shared/jira/jira-types'
import { buildJiraIssueWorkspaceAttachmentIndex } from '@/lib/jira-issue-workspace-attachment'
import { TooltipProvider } from '@/components/ui/tooltip'
import { defaultJiraListColumnIds, visibleJiraListColumns } from '../../jira-list-columns'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { clearTaskPageJiraBoardCache } from '../../task-page-jira-board-cache'
import { TaskPageJiraContent } from './Content'

const mocks = vi.hoisted(() => ({
  jiraGetBoardOverview: vi.fn(),
  jiraListBoardIssues: vi.fn(),
  jiraListTransitions: vi.fn(),
  jiraUpdateIssue: vi.fn()
}))

vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraGetBoardOverview: (...args: unknown[]) => mocks.jiraGetBoardOverview(...args),
  jiraListBoardIssues: (...args: unknown[]) => mocks.jiraListBoardIssues(...args),
  jiraListTransitions: (...args: unknown[]) => mocks.jiraListTransitions(...args),
  jiraUpdateIssue: (...args: unknown[]) => mocks.jiraUpdateIssue(...args)
}))

// The sheet is the surface that commits the move, so the test drives its callback
// directly; that the callback fires only on a committed move is the sheet's own test.
const sheet = vi.hoisted(() => {
  const holder: { onSprintChange?: () => void } = {}
  return holder
})
vi.mock('@/components/JiraIssueWorkspace', () => ({
  default: (props: { onSprintChange?: () => void }) => {
    sheet.onSprintChange = props.onSprintChange
    return null
  }
}))
vi.mock('@/components/task-page/linear/Content', () => ({ TaskPageLinearContent: () => null }))

/** What Jira answers once the drawer's move is committed. */
let movedToSprint = false
/** Backlog reads served, so a reload can be told from a cleared page. */
let backlogFetches = 0

function issue(key: string): JiraIssue {
  return {
    id: key,
    key,
    siteId: 'site-1',
    title: `${key} title`,
    url: `https://example.atlassian.net/browse/${key}`,
    project: { id: 'project-1', key: 'ABC', name: 'Payments' },
    issueType: { id: 'story', name: 'Story' },
    status: { id: '1', name: 'Ready', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    assignee: { accountId: 'viewer-1', displayName: 'Ada' },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z'
  }
}

const backlogIssue = issue('ABC-2')
const sprintIssue = issue('ABC-1')

const boardOverview = {
  board: { id: '42', name: 'Payments', type: 'scrum', siteId: 'site-1', siteName: 'Example' },
  columns: [{ name: 'Ready', statusIds: ['1'] }],
  activeSprints: [{ id: '87', name: 'September sprint', state: 'active' }],
  sprints: [{ id: '88', name: 'October sprint', state: 'future' }]
}

function model(
  setJiraRefreshNonce: () => void,
  view: 'list' | 'board' = 'board'
): TaskPageComposerActionsModel {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test supplies only the members this component reads.
  return {
    settings: createGlobalSettingsFixture({
      defaultJiraBoard: { boardId: '42', siteId: 'site-1' }
    }),
    jiraStatus: {
      connected: true,
      viewer: { accountId: 'viewer-1', displayName: 'Ada', email: null },
      activeSiteId: 'site-1',
      credentialError: null
    },
    jiraStatusReady: true,
    jiraConnected: true,
    jiraHasWorkspace: false,
    jiraTaskSourceContext: null,
    jiraTaskSourceScopeKey: 'sprint-refresh-scope',
    accountBackedTaskSourceHostId: 'runtime:account-jira-owner',
    selectedJiraSiteId: 'site-1',
    selectedJiraIssue: null,
    jiraDetailSourceContext: null,
    openJiraDetailPage: vi.fn(),
    closeTaskDetailPage: vi.fn(),
    hideTaskSource: vi.fn(),
    taskSource: 'jira',
    jiraBoardViewMode: view,
    setJiraBoardViewMode: vi.fn(),
    jiraViewMode: 'list',
    setJiraViewMode: vi.fn(),
    jiraCurrentSprint: false,
    setJiraCurrentSprint: vi.fn(),
    jiraIssueAttachmentIndex: buildJiraIssueWorkspaceAttachmentIndex([]),
    jiraIssues: [],
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
    displayedJiraIssues: [],
    displayedJiraStatusOrder: null,
    sortedJiraIssues: [],
    setJiraConnectOpen: vi.fn(),
    handleUseJiraItem: vi.fn(),
    handleOpenOrUseJiraItem: vi.fn(),
    getJiraIssueWorkspaces: () => [],
    setJiraRefreshNonce
  } as unknown as TaskPageComposerActionsModel
}

beforeEach(() => {
  clearTaskPageJiraBoardCache()
  localStorage.clear()
  movedToSprint = false
  backlogFetches = 0
  mocks.jiraGetBoardOverview.mockResolvedValue(boardOverview)
  mocks.jiraListBoardIssues.mockImplementation(
    (_settings: unknown, request: JiraBoardIssuePageRequest) => {
      if (request.scope === 'backlog') {
        backlogFetches += 1
      }
      return Promise.resolve({
        issues:
          request.scope === 'backlog' && !movedToSprint
            ? [backlogIssue]
            : request.scope === 'backlog'
              ? []
              : [sprintIssue],
        startAt: request.startAt ?? 0,
        nextPageToken: null,
        total: 1,
        isLast: true
      })
    }
  )
  mocks.jiraListTransitions.mockResolvedValue([])
  mocks.jiraUpdateIssue.mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  // Why: each case renders its own sheet, so a callback left behind would be a stale one.
  sheet.onSprintChange = undefined
})

describe('TaskPageJiraContent sprint assignment refresh', () => {
  it('drops a moved issue from the backlog once the sheet commits the sprint', async () => {
    const user = userEvent.setup()
    const setJiraRefreshNonce = vi.fn()
    render(
      <TooltipProvider>
        <TaskPageJiraContent model={model(setJiraRefreshNonce)} />
      </TooltipProvider>
    )

    await user.click(await screen.findByRole('button', { name: 'Backlog' }))
    await screen.findByText('ABC-2 title')
    expect(backlogFetches).toBe(1)

    // The drawer's own commit: Jira now answers with the item out of the backlog.
    await act(async () => {
      movedToSprint = true
      sheet.onSprintChange?.()
    })

    // A second backlog read, and the settled empty state — a reload that cleared the
    // page but never answered would leave the board on its loader instead.
    await waitFor(() => expect(backlogFetches).toBe(2))
    await screen.findByText('No backlog issues match this filter.')
    expect(screen.queryByText('ABC-2 title')).toBeNull()
  })

  it('re-searches the issue list when the sheet commits a sprint move', () => {
    // The board is not mounted in list mode, so the list nonce is the whole answer here;
    // that a nonce change forces a fresh read is pinned by the list-effects suite.
    const setJiraRefreshNonce = vi.fn()
    render(
      <TooltipProvider>
        <TaskPageJiraContent model={model(setJiraRefreshNonce, 'list')} />
      </TooltipProvider>
    )
    expect(setJiraRefreshNonce).not.toHaveBeenCalled()

    act(() => sheet.onSprintChange?.())

    expect(setJiraRefreshNonce).toHaveBeenCalledTimes(1)
  })
})
