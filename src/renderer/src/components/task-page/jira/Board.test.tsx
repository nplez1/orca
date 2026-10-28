// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useEffect, useState, type JSX } from 'react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  JiraBoardIssuePage,
  JiraBoardIssuePageRequest,
  JiraIssue,
  JiraTransition
} from '../../../../../shared/jira/jira-types'
import type { TaskPageJiraBoardModel } from './Board'
import { TaskPageJiraBoard } from './Board'
import { buildJiraIssueWorkspaceAttachmentIndex } from '@/lib/jira-issue-workspace-attachment'
import type { Worktree } from '../../../../../shared/worktree/types'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  clearTaskPageJiraBoardCache,
  patchTaskPageJiraBoardCache,
  readTaskPageJiraBoardCache,
  taskPageJiraBoardCacheKey
} from '../../task-page-jira-board-cache'
import {
  loadJiraBoardViewPreferences,
  saveJiraBoardViewPreferences
} from '../../jira-board-view-storage'

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

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({})
}))

function issue(key: string, statusId: string, overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: key,
    key,
    siteId: 'site-1',
    title: `${key} title`,
    url: `https://example.atlassian.net/browse/${key}`,
    project: { id: 'project-1', key: 'ABC', name: 'Payments' },
    issueType: { id: 'story', name: 'Story' },
    status: {
      id: statusId,
      name: statusId === '1' ? 'Ready' : 'In Progress',
      categoryKey: statusId === '1' ? 'new' : 'indeterminate',
      categoryName: statusId === '1' ? 'To Do' : 'In Progress'
    },
    labels: [],
    assignee: { accountId: 'viewer-1', displayName: 'Ada' },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    ...overrides
  }
}

const sprintIssue = issue('ABC-1', '1')
// Why a second viewer-held issue: the board opens on the Me filter, so anything else
// cannot stand in for the card a reload must not take off screen.
const secondSprintIssue = issue('ABC-6', '1')
const otherAssigneeIssue = issue('ABC-9', '1', {
  assignee: { accountId: 'viewer-2', displayName: 'Grace' }
})
const backlogIssue = issue('ABC-2', '1')
const cachedIssue = issue('ABC-7', '1')

function attachedWorktree(key: string, displayName: string): Worktree {
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
const startTransition: JiraTransition = {
  id: 'start-work',
  name: 'Start work',
  to: {
    id: '3',
    name: 'In Progress',
    categoryKey: 'indeterminate',
    categoryName: 'In Progress'
  }
}

const boardOverview = {
  board: { id: '42', name: 'Payments', type: 'scrum', siteId: 'site-1', siteName: 'Example' },
  columns: [
    { name: 'Ready', statusIds: ['1'] },
    { name: 'Doing', statusIds: ['3'] }
  ],
  activeSprints: [{ id: '87', name: 'September sprint', state: 'active' }],
  sprints: [
    { id: '87', name: 'September sprint', state: 'active' },
    { id: '88', name: 'October sprint', state: 'future' }
  ]
}

/** The account host the model names for this board. The model carries no settings, so the
 *  reader cannot re-derive one — which is what this fixture pins. */
const BOARD_OWNER = { kind: 'environment', environmentId: 'board-owner' } as const

const model: TaskPageJiraBoardModel = {
  accountBackedTaskSourceHostId: 'runtime:board-owner',
  jiraTaskSourceContext: null,
  jiraStatus: {
    connected: true,
    viewer: { accountId: 'viewer-1', displayName: 'Ada', email: null },
    activeSiteId: 'site-1'
  },
  selectedJiraIssue: null,
  jiraIssueAttachmentIndex: buildJiraIssueWorkspaceAttachmentIndex([]),
  openJiraDetailPage: vi.fn(),
  handleOpenOrUseJiraItem: vi.fn(),
  getJiraIssueWorkspaces: () => [],
  handleUseJiraItem: vi.fn()
}

function boardTree(
  renderedModel: TaskPageJiraBoardModel,
  props: { onUseIssueList?: () => void; onIssueMoved?: () => void } = {}
) {
  return (
    <TooltipProvider>
      <TaskPageJiraBoard
        model={renderedModel}
        selection={{ boardId: '42', siteId: 'site-1' }}
        onUseIssueList={props.onUseIssueList ?? vi.fn()}
        onIssueMoved={props.onIssueMoved ?? vi.fn()}
      />
    </TooltipProvider>
  )
}

function renderBoard(
  props: {
    onUseIssueList?: () => void
    onIssueMoved?: () => void
    model?: TaskPageJiraBoardModel
  } = {}
) {
  return render(boardTree(props.model ?? model, props))
}

/** Starts a drag of `key` and drops it on `target`, the way the board's handlers see it. */
function dragCardOnto(card: HTMLElement, target: HTMLElement, key: string): void {
  const dataTransfer = {
    effectAllowed: 'move',
    dropEffect: 'none',
    setData: vi.fn(),
    getData: vi.fn().mockReturnValue(key)
  }
  const dragStart = new Event('dragstart', { bubbles: true, cancelable: true })
  Object.defineProperty(dragStart, 'dataTransfer', { value: dataTransfer })
  fireEvent(card, dragStart)
  const drop = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer })
  fireEvent(target, drop)
}

/** A one-page board answer, the depth a first read returns. */
function boardPage(issues: JiraIssue[]): JiraBoardIssuePage {
  return { issues, startAt: 0, nextPageToken: null, total: issues.length, isLast: true }
}

/** Holds the sprint refetch a mutation asks for, so the window it runs in is observable. */
function holdSprintRefetch(): {
  resolve: (page: JiraBoardIssuePage) => void
  sprintCalls: () => number
} {
  let resolveHeld: (page: JiraBoardIssuePage) => void = () => {}
  // Why one shared promise: an explicit refresh can issue the read more than once, and
  // a per-call deferred would leave the later ones pending for good.
  const held = new Promise<JiraBoardIssuePage>((resolve) => {
    resolveHeld = resolve
  })
  let sprintCalls = 0
  mocks.jiraListBoardIssues.mockImplementation(
    (_settings: unknown, request: JiraBoardIssuePageRequest) => {
      if (request.scope === 'backlog') {
        return Promise.resolve(boardPage([backlogIssue]))
      }
      sprintCalls += 1
      return sprintCalls === 1 ? Promise.resolve(boardPage([sprintIssue, secondSprintIssue])) : held
    }
  )
  return { resolve: (page) => resolveHeld(page), sprintCalls: () => sprintCalls }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('TaskPageJiraBoard', () => {
  beforeEach(() => {
    clearTaskPageJiraBoardCache()
    localStorage.clear()
    mocks.jiraGetBoardOverview.mockResolvedValue(boardOverview)
    mocks.jiraListBoardIssues.mockImplementation(
      (_settings: unknown, request: JiraBoardIssuePageRequest) =>
        Promise.resolve({
          issues: request.scope === 'backlog' ? [backlogIssue] : [sprintIssue, otherAssigneeIssue],
          startAt: request.startAt ?? 0,
          nextPageToken: null,
          total: 2,
          isLast: true
        })
    )
    mocks.jiraListTransitions.mockResolvedValue([startTransition])
    mocks.jiraUpdateIssue.mockResolvedValue({ ok: true })
  })

  it('shows the active sprint columns and the full backlog in a separate view', async () => {
    const user = userEvent.setup()
    renderBoard()

    await screen.findByText('September sprint')
    expect(screen.getAllByText('Ready').length).toBeGreaterThan(0)
    expect(screen.getByText('Doing')).toBeTruthy()
    expect(await screen.findByText('ABC-1')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Backlog' }))
    expect(await screen.findByText('1 loaded')).toBeTruthy()
    expect(await screen.findByText('ABC-2 title')).toBeTruthy()
    expect(mocks.jiraListBoardIssues).toHaveBeenCalledWith(
      BOARD_OWNER,
      expect.objectContaining({ boardId: '42', scope: 'backlog', siteId: 'site-1' })
    )
  })

  it('marks a board card whose issue already has a workspace', async () => {
    renderBoard({
      model: {
        ...model,
        jiraIssueAttachmentIndex: buildJiraIssueWorkspaceAttachmentIndex([
          attachedWorktree('ABC-1', 'abc-1-fix-payments')
        ])
      }
    })

    expect(await screen.findByText('ABC-1 title')).toBeTruthy()
    expect(screen.getByText('abc-1-fix-payments')).toBeTruthy()
  })

  it('opens on the viewer filter and only widens to every issue on demand', async () => {
    const user = userEvent.setup()
    renderBoard()

    expect(await screen.findByText('ABC-1 title')).toBeTruthy()
    expect(screen.queryByText('ABC-9 title')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'All' }))
    expect(await screen.findByText('ABC-9 title')).toBeTruthy()
  })

  it('keeps an issue the viewer holds a role on and drops one they only reported', async () => {
    const user = userEvent.setup()
    const roleIssue = issue('ABC-4', '1', {
      assignee: { accountId: 'viewer-2', displayName: 'Grace' },
      roleAssignees: [{ accountId: 'viewer-1', displayName: 'Ada' }]
    })
    const reportedIssue = issue('ABC-6', '1', {
      assignee: { accountId: 'viewer-2', displayName: 'Grace' },
      reporter: { accountId: 'viewer-1', displayName: 'Ada' }
    })
    mocks.jiraListBoardIssues.mockImplementation(
      (_settings: unknown, request: JiraBoardIssuePageRequest) =>
        Promise.resolve({
          issues:
            request.scope === 'backlog'
              ? [backlogIssue]
              : [sprintIssue, otherAssigneeIssue, roleIssue, reportedIssue],
          startAt: request.startAt ?? 0,
          nextPageToken: null,
          total: 4,
          isLast: true
        })
    )
    renderBoard()

    // The board opens on the viewer's own work, which is any role they hold — not only
    // the assignee, and never just having filed the issue.
    expect(await screen.findByText('ABC-4 title')).toBeTruthy()
    expect(screen.getByText('ABC-1 title')).toBeTruthy()
    expect(screen.queryByText('ABC-6 title')).toBeNull()
    expect(screen.queryByText('ABC-9 title')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'All' }))
    expect(await screen.findByText('ABC-6 title')).toBeTruthy()
    expect(screen.getByText('ABC-9 title')).toBeTruthy()
  })

  it('shows every issue when the board site has no resolvable viewer account', async () => {
    renderBoard({
      model: {
        ...model,
        jiraStatus: {
          connected: true,
          viewer: { accountId: 'viewer-1', displayName: 'Ada', email: null }
        }
      }
    })

    expect(await screen.findByText('ABC-1 title')).toBeTruthy()
    expect(await screen.findByText('ABC-9 title')).toBeTruthy()
  })

  it('keeps the saved Me preference while the viewer account is unresolved', async () => {
    saveJiraBoardViewPreferences({
      viewMode: 'list',
      activeView: 'sprint',
      filter: 'me',
      query: ''
    })
    const view = renderBoard({
      model: {
        ...model,
        jiraStatus: {
          connected: true,
          viewer: { accountId: 'viewer-1', displayName: 'Ada', email: null }
        }
      }
    })

    // Me cannot be answered without a site viewer, so the board falls back to showing everyone.
    expect(await screen.findByText('ABC-9 title')).toBeTruthy()
    expect(loadJiraBoardViewPreferences()).toMatchObject({ filter: 'me', viewMode: 'list' })

    view.rerender(boardTree(model))

    await waitFor(() => expect(screen.queryByText('ABC-9 title')).toBeNull())
    expect(screen.getByRole('button', { name: 'Me' }).getAttribute('aria-pressed')).toBe('true')
    expect(loadJiraBoardViewPreferences()).toMatchObject({ filter: 'me', viewMode: 'list' })
  })

  it('does not refetch when the model is re-created for the same owner', async () => {
    const view = renderBoard()
    await screen.findByText('ABC-1 title')
    const overviewCalls = mocks.jiraGetBoardOverview.mock.calls.length
    const pageCalls = mocks.jiraListBoardIssues.mock.calls.length

    // Why: a store write re-creates the model object, and re-deriving a fresh owner target here
    // would re-run every load effect. Only the owner's own host id may move them.
    view.rerender(boardTree({ ...model }))

    expect(mocks.jiraGetBoardOverview).toHaveBeenCalledTimes(overviewCalls)
    expect(mocks.jiraListBoardIssues).toHaveBeenCalledTimes(pageCalls)
  })

  it('revalidates behind the loaded board when the owner changes', async () => {
    const view = renderBoard()
    await screen.findByText('ABC-1 title')

    // Pending reads prove the rerun revalidated behind the loaded board instead of blanking it.
    mocks.jiraGetBoardOverview.mockReturnValue(new Promise(() => {}))
    mocks.jiraListBoardIssues.mockReturnValue(new Promise(() => {}))
    view.rerender(boardTree({ ...model, accountBackedTaskSourceHostId: 'runtime:other-owner' }))

    expect(screen.queryByText('Loading…')).toBeNull()
    expect(screen.getByText('ABC-1 title')).toBeTruthy()
    expect(mocks.jiraGetBoardOverview).toHaveBeenLastCalledWith(
      { kind: 'environment', environmentId: 'other-owner' },
      '42',
      'site-1'
    )
  })

  it('remembers the selected sprint across a remount without mixing sprint pages', async () => {
    const user = userEvent.setup()
    mocks.jiraGetBoardOverview.mockResolvedValue({
      ...boardOverview,
      activeSprints: [
        { id: '87', name: 'September sprint', state: 'active' },
        { id: '88', name: 'October sprint', state: 'active' }
      ]
    })
    mocks.jiraListBoardIssues.mockImplementation(
      (_settings: unknown, request: JiraBoardIssuePageRequest) =>
        Promise.resolve({
          issues:
            request.scope === 'backlog'
              ? [backlogIssue]
              : request.sprintId === '88'
                ? [cachedIssue]
                : [sprintIssue, otherAssigneeIssue],
          startAt: request.startAt ?? 0,
          nextPageToken: null,
          total: 1,
          isLast: true
        })
    )

    const view = renderBoard()
    await screen.findByText('ABC-1 title')
    await user.click(screen.getByRole('combobox'))
    await user.click(await screen.findByRole('option', { name: 'October sprint' }))
    await screen.findByText('ABC-7 title')

    const cached = readTaskPageJiraBoardCache(
      taskPageJiraBoardCacheKey({ siteId: 'site-1', boardId: '42' })
    )
    expect(cached?.activeSprintId).toBe('88')
    expect(cached?.sprint?.issues.map((issue) => issue.key)).toEqual(['ABC-7'])

    view.unmount()
    // Pending reads prove the remount rendered the cached selection instead of refetching.
    mocks.jiraGetBoardOverview.mockReturnValue(new Promise(() => {}))
    mocks.jiraListBoardIssues.mockReturnValue(new Promise(() => {}))
    renderBoard()

    expect(screen.getByText('ABC-7 title')).toBeTruthy()
    expect(screen.queryByText('ABC-1 title')).toBeNull()
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('narrows the rendered issues by typed text without refetching the board', async () => {
    const user = userEvent.setup()
    renderBoard()
    await screen.findByText('ABC-1 title')
    await user.click(screen.getByRole('button', { name: 'All' }))
    await screen.findByText('ABC-9 title')

    const callsBeforeFilter = mocks.jiraListBoardIssues.mock.calls.length
    await user.type(screen.getByRole('textbox', { name: 'Filter board issues' }), 'ABC-9')

    expect(await screen.findByText('ABC-9 title')).toBeTruthy()
    expect(screen.queryByText('ABC-1 title')).toBeNull()
    expect(mocks.jiraListBoardIssues.mock.calls.length).toBe(callsBeforeFilter)
  })

  it('renders the cached board immediately and revalidates without a loading screen', async () => {
    // Why: a pending revalidation proves the cached board rendered first, not the network.
    mocks.jiraGetBoardOverview.mockReturnValue(new Promise(() => {}))
    mocks.jiraListBoardIssues.mockReturnValue(new Promise(() => {}))
    patchTaskPageJiraBoardCache(taskPageJiraBoardCacheKey({ siteId: 'site-1', boardId: '42' }), {
      overview: boardOverview,
      activeSprintId: '87',
      sprint: { issues: [cachedIssue], startAt: 1, pageToken: null, isLast: true, total: null }
    })

    renderBoard()

    expect(screen.getByText('ABC-7 title')).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(mocks.jiraGetBoardOverview).toHaveBeenCalled()
  })

  it("shows the card's story points in its top corner, and nothing when Jira holds none", async () => {
    const pointed = issue('ABC-5', '1', { storyPoints: 3, storyPointsFieldId: 'customfield_3' })
    const zeroed = issue('ABC-6', '1', { storyPoints: 0, storyPointsFieldId: 'customfield_3' })
    const unpointed = issue('ABC-7', '1')
    mocks.jiraListBoardIssues.mockImplementation(
      (_settings: unknown, request: JiraBoardIssuePageRequest) =>
        Promise.resolve({
          issues: request.scope === 'backlog' ? [] : [pointed, zeroed, unpointed],
          startAt: request.startAt ?? 0,
          nextPageToken: null,
          total: 3,
          isLast: true
        })
    )
    renderBoard()

    const card = await screen.findByRole('button', { name: /ABC-5 title/ })
    expect(within(card).getByTitle('Story points').textContent).toBe('3sp')
    // Zero is a value Jira holds, not an absence.
    expect((await screen.findByRole('button', { name: /ABC-6 title/ })).textContent).toContain(
      '0sp'
    )
    // A card with no points holds no chip at all rather than an empty one.
    const bare = await screen.findByRole('button', { name: /ABC-7 title/ })
    expect(within(bare).queryByTitle('Story points')).toBeNull()
  })

  it('washes a blocker card and labels its severity', async () => {
    const blocker = issue('ABC-5', '1', {
      priority: { id: 'blocker', name: 'Blocker' }
    })
    mocks.jiraListBoardIssues.mockImplementation(
      (_settings: unknown, request: JiraBoardIssuePageRequest) =>
        Promise.resolve({
          issues: request.scope === 'backlog' ? [] : [blocker],
          startAt: request.startAt ?? 0,
          nextPageToken: null,
          total: 1,
          isLast: true
        })
    )
    renderBoard()

    const card = await screen.findByRole('button', { name: /ABC-5 title/ })
    expect(card.className).toContain('bg-jira-priority-high/10')
    expect(card.className).toContain('border-jira-priority-high/40')
    expect(screen.getAllByText('Blocker').length).toBeGreaterThan(0)
  })

  it('opens the backlog instead of an empty sprint view for boards without active sprints', async () => {
    mocks.jiraGetBoardOverview.mockResolvedValue({
      board: { id: '42', name: 'Triage', type: 'kanban', siteId: 'site-1', siteName: 'Example' },
      columns: [{ name: 'To do', statusIds: ['1'] }],
      activeSprints: []
    })
    renderBoard()

    expect(await screen.findByText('1 loaded')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sprint' }).hasAttribute('disabled')).toBe(true)
    expect(
      screen.getByText('This board does not use sprints; showing its board-filter backlog.')
    ).toBeTruthy()
    expect(await screen.findByText('ABC-2 title')).toBeTruthy()
  })

  it('falls back to the issue list when an older runtime lacks board methods', async () => {
    const onUseIssueList = vi.fn()
    mocks.jiraGetBoardOverview.mockRejectedValue(
      Object.assign(new Error('Unknown method: jira.getBoardOverview'), {
        code: 'method_not_found'
      })
    )
    renderBoard({ onUseIssueList })

    await waitFor(() => expect(onUseIssueList).toHaveBeenCalledOnce())
  })

  it('moves a backlog item into a sprint from its own row', async () => {
    const user = userEvent.setup()
    const onIssueMoved = vi.fn()
    renderBoard({ onIssueMoved })

    await user.click(screen.getByRole('button', { name: 'Backlog' }))
    await screen.findByText('ABC-2 title')

    await user.click(screen.getByRole('button', { name: '+ Sprint' }))
    // The backlog row offers the open sprints and nothing else: it is already the backlog.
    const options = document.querySelector('[data-slot="popover-content"]')
    expect(options?.textContent).toContain('October sprint')
    expect(options?.textContent).not.toContain('Backlog')
    await user.click(await screen.findByRole('option', { name: /October sprint/ }))

    await waitFor(() =>
      expect(mocks.jiraUpdateIssue).toHaveBeenCalledWith(
        BOARD_OWNER,
        backlogIssue.key,
        { sprintId: '88' },
        backlogIssue.siteId
      )
    )
    expect(onIssueMoved).toHaveBeenCalledWith(backlogIssue)
    // Why: the cell and its portalled popover live inside a clickable row, so neither the
    // trigger nor an option may also open the issue.
    expect(model.openJiraDetailPage).not.toHaveBeenCalled()
  })

  it('starts one backlog row move at a time', async () => {
    const user = userEvent.setup()
    const secondBacklogIssue = issue('ABC-3', '1')
    mocks.jiraListBoardIssues.mockImplementation(
      (_settings: unknown, request: JiraBoardIssuePageRequest) =>
        Promise.resolve({
          issues:
            request.scope === 'backlog'
              ? [backlogIssue, secondBacklogIssue]
              : [sprintIssue, otherAssigneeIssue],
          startAt: request.startAt ?? 0,
          nextPageToken: null,
          total: 2,
          isLast: true
        })
    )
    let finishMove: (result: unknown) => void = () => {}
    mocks.jiraUpdateIssue.mockReturnValue(
      new Promise((resolve) => {
        finishMove = resolve
      })
    )

    renderBoard()
    await user.click(screen.getByRole('button', { name: 'Backlog' }))
    await screen.findByText('ABC-3 title')

    const sprintButtons = await screen.findAllByRole('button', { name: '+ Sprint' })
    expect(sprintButtons).toHaveLength(2)
    await user.click(sprintButtons[0])
    await user.click(await screen.findByRole('option', { name: /October sprint/ }))

    // The first move is still in flight, so a second row must not start its own —
    // the shared row state is what disables the rows and gates drops.
    await user.click(screen.getAllByRole('button', { name: '+ Sprint' })[1])
    await user.click(await screen.findByRole('option', { name: /September sprint/ }))
    expect(mocks.jiraUpdateIssue).toHaveBeenCalledTimes(1)

    finishMove({ ok: true })
    await screen.findByText('ABC-2 title')
  })

  it('offers no sprint control on a board whose backlog has no sprints', async () => {
    const user = userEvent.setup()
    mocks.jiraGetBoardOverview.mockResolvedValue({ ...boardOverview, sprints: [] })
    renderBoard()

    await user.click(screen.getByRole('button', { name: 'Backlog' }))
    await screen.findByText('ABC-2 title')

    expect(screen.queryByRole('button', { name: '+ Sprint' })).toBeNull()
  })

  it('opens issue details and applies only an available status transition after a drop', async () => {
    const user = userEvent.setup()
    const onIssueMoved = vi.fn()
    renderBoard({ onIssueMoved })

    const card = await screen.findByRole('button', { name: /ABC-1 title/ })
    await user.click(card)
    expect(model.openJiraDetailPage).toHaveBeenCalledWith(sprintIssue)

    const dataTransfer = {
      effectAllowed: 'move',
      dropEffect: 'none',
      setData: vi.fn(),
      getData: vi.fn().mockReturnValue(sprintIssue.key)
    }
    const dragStart = new Event('dragstart', { bubbles: true, cancelable: true })
    Object.defineProperty(dragStart, 'dataTransfer', { value: dataTransfer })
    fireEvent(card, dragStart)

    const doingColumn = screen.getByText('Doing').closest('section')
    if (!doingColumn) {
      throw new Error('Doing column was not rendered')
    }
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer })
    fireEvent(doingColumn, drop)

    await waitFor(() =>
      expect(mocks.jiraUpdateIssue).toHaveBeenCalledWith(
        BOARD_OWNER,
        sprintIssue.key,
        { transitionId: 'start-work' },
        sprintIssue.siteId
      )
    )
    expect(onIssueMoved).toHaveBeenCalledWith(sprintIssue)
  })

  it('moves the card into the new lane before Jira confirms the transition', async () => {
    const onIssueMoved = vi.fn()
    let resolveUpdate: (value: { ok: true }) => void = () => {}
    mocks.jiraUpdateIssue.mockImplementation(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveUpdate = resolve
        })
    )
    renderBoard({ onIssueMoved })

    const card = await screen.findByRole('button', { name: /ABC-1 title/ })
    const doingColumn = screen.getByText('Doing').closest('section')
    if (!doingColumn) {
      throw new Error('Doing column was not rendered')
    }
    dragCardOnto(card, doingColumn, sprintIssue.key)

    // The point of the optimistic move: the card is already where it was dropped
    // while the transition request is still outstanding.
    await waitFor(() => {
      expect(screen.getByText('ABC-1').closest('section')?.textContent).toContain('Doing')
    })

    await act(async () => {
      resolveUpdate({ ok: true })
    })
    await waitFor(() => expect(onIssueMoved).toHaveBeenCalledWith(sprintIssue))
  })

  it('keeps the rendered cards while a lane drop refetches the sprint', async () => {
    const refetch = holdSprintRefetch()
    renderBoard()

    const card = await screen.findByRole('button', { name: /ABC-1 title/ })
    const doingColumn = screen.getByText('Doing').closest('section')
    if (!doingColumn) {
      throw new Error('Doing column was not rendered')
    }
    dragCardOnto(card, doingColumn, sprintIssue.key)

    // The reload the move asked for is in flight, and the board is still drawn under it.
    await waitFor(() => expect(refetch.sprintCalls()).toBe(2))
    expect(screen.getByText('ABC-1').closest('section')?.textContent).toContain('Doing')
    expect(screen.getByText('ABC-6')).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()

    await act(async () => {
      refetch.resolve(boardPage([issue('ABC-1', '3'), secondSprintIssue, issue('ABC-3', '3')]))
    })

    // The answer still reconciles: an issue the client did not predict lands too.
    expect(await screen.findByText('ABC-3')).toBeTruthy()
    expect(screen.getByText('ABC-1').closest('section')?.textContent).toContain('Doing')
  })

  it('still blanks the board for the header refresh', async () => {
    const user = userEvent.setup()
    const refetch = holdSprintRefetch()
    renderBoard()

    await screen.findByRole('button', { name: /ABC-1 title/ })
    await user.click(screen.getByRole('button', { name: 'Refresh Jira issues' }))

    // An explicit refresh is the one reload allowed to empty the board behind a loader.
    await waitFor(() => expect(screen.queryByText('ABC-1')).toBeNull())
    expect(await screen.findByText('Loading…')).toBeTruthy()

    await act(async () => {
      refetch.resolve(boardPage([sprintIssue, secondSprintIssue]))
    })

    expect(await screen.findByText('ABC-1')).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('prompts for a transition screen field and submits it with the move', async () => {
    const user = userEvent.setup()
    mocks.jiraListTransitions.mockResolvedValue([
      {
        ...startTransition,
        fields: [
          { key: 'customfield_10001', name: 'Dev', required: true, schema: { type: 'string' } }
        ]
      }
    ])
    renderBoard()

    const card = await screen.findByRole('button', { name: /ABC-1 title/ })
    const doingColumn = screen.getByText('Doing').closest('section')
    if (!doingColumn) {
      throw new Error('Doing column was not rendered')
    }
    dragCardOnto(card, doingColumn, sprintIssue.key)

    await user.type(await screen.findByPlaceholderText('Enter Dev'), 'platform')
    // Why 'Change status': every surface renders the same fields form, so the
    // board drop submits with the label the status control uses.
    await user.click(screen.getByRole('button', { name: 'Change status' }))

    await waitFor(() =>
      expect(mocks.jiraUpdateIssue).toHaveBeenCalledWith(
        BOARD_OWNER,
        sprintIssue.key,
        expect.objectContaining({
          transitionId: 'start-work',
          transitionFields: { customfield_10001: 'platform' }
        }),
        sprintIssue.siteId
      )
    )
  })

  it('moves a card dropped on the Other statuses bucket to a status no column owns', async () => {
    const otherStatusIssue = issue('ABC-4', '9')
    mocks.jiraListBoardIssues.mockResolvedValue({
      issues: [sprintIssue, otherStatusIssue],
      startAt: 0,
      nextPageToken: null,
      total: 2,
      isLast: true
    })
    mocks.jiraListTransitions.mockResolvedValue([
      {
        ...startTransition,
        id: 'ship',
        name: 'Ship',
        to: { ...startTransition.to, id: '9', name: 'Shipped' }
      }
    ])
    renderBoard()

    const card = await screen.findByRole('button', { name: /ABC-1 title/ })
    const otherBucket = (await screen.findByText('Other statuses')).closest('section')
    if (!otherBucket) {
      throw new Error('Other statuses bucket was not rendered')
    }
    dragCardOnto(card, otherBucket, sprintIssue.key)

    await waitFor(() =>
      expect(mocks.jiraUpdateIssue).toHaveBeenCalledWith(
        expect.anything(),
        sprintIssue.key,
        { transitionId: 'ship' },
        sprintIssue.siteId
      )
    )
  })

  it('shows only unassigned issues behind the Unassigned filter', async () => {
    const user = userEvent.setup()
    mocks.jiraListBoardIssues.mockResolvedValue({
      issues: [sprintIssue, otherAssigneeIssue, issue('ABC-5', '1', { assignee: undefined })],
      startAt: 0,
      nextPageToken: null,
      total: 3,
      isLast: true
    })
    renderBoard()

    await screen.findByText('ABC-1')
    await user.click(screen.getByRole('button', { name: 'Unassigned' }))

    await waitFor(() => expect(screen.queryByText('ABC-1')).toBeNull())
    expect(screen.getByText('ABC-5')).toBeTruthy()
  })
})

describe('TaskPageJiraBoard external refresh signal', () => {
  /** Set by `RefreshHost`'s effect so a test can raise the parent's signal. */
  let bumpBoardRefresh: () => void = () => {}
  /** What Jira answers for the backlog once a move has taken the item out of it. */
  let movedToSprint = false
  // Why counted here rather than read off mock.calls: the scope only narrows the argument.
  let backlogFetches = 0

  beforeEach(() => {
    clearTaskPageJiraBoardCache()
    localStorage.clear()
    movedToSprint = false
    backlogFetches = 0
    // Why: a host left behind by another case must not be reachable from this one.
    bumpBoardRefresh = () => {}
    mocks.jiraGetBoardOverview.mockResolvedValue(boardOverview)
    mocks.jiraListBoardIssues.mockImplementation(
      (_settings: unknown, request: JiraBoardIssuePageRequest) => {
        if (request.scope === 'backlog') {
          backlogFetches += 1
        }
        return Promise.resolve({
          issues:
            request.scope === 'backlog' ? (movedToSprint ? [] : [backlogIssue]) : [sprintIssue],
          startAt: request.startAt ?? 0,
          nextPageToken: null,
          total: 1,
          isLast: true
        })
      }
    )
    mocks.jiraListTransitions.mockResolvedValue([startTransition])
    mocks.jiraUpdateIssue.mockResolvedValue({ ok: true })
  })

  /** Hosts the board the way the tasks page does, so the parent can raise the signal. */
  function RefreshHost(): JSX.Element {
    // Why non-zero: a signal the parent raised before this board mounted must not be
    // mistaken for a refresh request, and only a value it could not have started at
    // can catch an implementation that forgot the guard.
    const [signal, setSignal] = useState(3)
    useEffect(() => {
      bumpBoardRefresh = () => setSignal((value) => value + 1)
    }, [])
    return (
      <TooltipProvider>
        <TaskPageJiraBoard
          model={model}
          selection={{ boardId: '42', siteId: 'site-1' }}
          onUseIssueList={vi.fn()}
          onIssueMoved={vi.fn()}
          refreshSignal={signal}
        />
      </TooltipProvider>
    )
  }

  it('reloads the backlog and the overview when the tasks view signals a sprint move', async () => {
    const user = userEvent.setup()
    render(<RefreshHost />)
    await screen.findByText('ABC-1 title')
    // The signal it mounted with did not ask for a reload.
    expect(mocks.jiraGetBoardOverview).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Backlog' }))
    await screen.findByText('ABC-2 title')
    const overviewCalls = mocks.jiraGetBoardOverview.mock.calls.length
    expect(backlogFetches).toBe(1)

    await act(async () => {
      movedToSprint = true
      bumpBoardRefresh()
    })

    // The reload, not a local removal, is what takes the moved item out of the backlog:
    // a fetch that started but answered stale data would leave the row on screen.
    await waitFor(() => expect(backlogFetches).toBe(2))
    await waitFor(() => expect(screen.queryByText('ABC-2 title')).toBeNull())
    expect(screen.getByText('No backlog issues match this filter.')).toBeTruthy()
    expect(mocks.jiraGetBoardOverview.mock.calls.length).toBe(overviewCalls + 1)
  })
})
