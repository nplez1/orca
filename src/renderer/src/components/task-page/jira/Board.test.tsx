// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../../shared/global-settings-test-fixture'
import type {
  JiraBoardIssuePageRequest,
  JiraIssue,
  JiraTransition
} from '../../../../../shared/jira-types'
import type { TaskPageJiraBoardModel } from './Board'
import { TaskPageJiraBoard } from './Board'
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
const otherAssigneeIssue = issue('ABC-9', '1', {
  assignee: { accountId: 'viewer-2', displayName: 'Grace' }
})
const backlogIssue = issue('ABC-2', '1')
const cachedIssue = issue('ABC-7', '1')
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
  activeSprints: [{ id: '87', name: 'September sprint', state: 'active' }]
}

const model: TaskPageJiraBoardModel = {
  settings: createGlobalSettingsFixture({
    defaultJiraBoard: { boardId: '42', siteId: 'site-1' }
  }),
  jiraTaskSourceContext: null,
  jiraStatus: {
    connected: true,
    viewer: { accountId: 'viewer-1', displayName: 'Ada', email: null },
    activeSiteId: 'site-1'
  },
  selectedJiraIssue: null,
  openJiraDetailPage: vi.fn(),
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
      model.settings,
      expect.objectContaining({ boardId: '42', scope: 'backlog', siteId: 'site-1' })
    )
  })

  it('opens on the viewer filter and only widens to every issue on demand', async () => {
    const user = userEvent.setup()
    renderBoard()

    expect(await screen.findByText('ABC-1 title')).toBeTruthy()
    expect(screen.queryByText('ABC-9 title')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'All' }))
    expect(await screen.findByText('ABC-9 title')).toBeTruthy()
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

  it('does not re-show a loader when a settings reload re-runs the fetch', async () => {
    const view = renderBoard()
    await screen.findByText('ABC-1 title')

    // Pending reads prove the rerun revalidated behind the loaded board instead of blanking it.
    mocks.jiraGetBoardOverview.mockReturnValue(new Promise(() => {}))
    mocks.jiraListBoardIssues.mockReturnValue(new Promise(() => {}))
    view.rerender(
      boardTree({ ...model, settings: createGlobalSettingsFixture(model.settings ?? {}) })
    )

    expect(screen.queryByText('Loading…')).toBeNull()
    expect(screen.getByText('ABC-1 title')).toBeTruthy()
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
    expect(card.className).toContain('bg-severity-blocker/10')
    expect(card.className).toContain('border-severity-blocker/40')
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
        model.settings,
        sprintIssue.key,
        { transitionId: 'start-work' },
        sprintIssue.siteId
      )
    )
    expect(onIssueMoved).toHaveBeenCalledWith(sprintIssue)
  })
})
