// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
import { TooltipProvider } from '@/components/ui/tooltip'
import { clearTaskPageJiraBoardCache } from '../../task-page-jira-board-cache'

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

function boardPage(
  issues: JiraIssue[],
  overrides: Partial<JiraBoardIssuePage> = {}
): JiraBoardIssuePage {
  return {
    issues,
    startAt: 0,
    nextPageToken: null,
    total: issues.length,
    isLast: true,
    ...overrides
  }
}

/**
 * Holds every sprint read after the first one, so the window a reload runs in is
 * observable. The first page is what the mount answers with.
 */
function holdSprintRefetch(firstPage: JiraBoardIssuePage): {
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
      return sprintCalls === 1 ? Promise.resolve(firstPage) : held
    }
  )
  return { resolve: (page) => resolveHeld(page), sprintCalls: () => sprintCalls }
}

function renderBoard(): void {
  render(
    <TooltipProvider>
      <TaskPageJiraBoard
        model={model}
        selection={{ boardId: '42', siteId: 'site-1' }}
        onUseIssueList={vi.fn()}
        onBoardUnavailable={vi.fn()}
        onIssueMoved={vi.fn()}
      />
    </TooltipProvider>
  )
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

/** Hosts the board the way the tasks page does, so the parent can raise the refresh signal. */
function RefreshHost(): JSX.Element {
  // Why non-zero: a signal the parent raised before this board mounted must not be
  // mistaken for a refresh request.
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
        onBoardUnavailable={vi.fn()}
        onIssueMoved={vi.fn()}
        refreshSignal={signal}
      />
    </TooltipProvider>
  )
}

/** Set by `RefreshHost`, so a test can raise the parent's signal. */
let bumpBoardRefresh: () => void = () => {}

beforeEach(() => {
  clearTaskPageJiraBoardCache()
  localStorage.clear()
  bumpBoardRefresh = () => {}
  mocks.jiraGetBoardOverview.mockResolvedValue(boardOverview)
  mocks.jiraListBoardIssues.mockImplementation(
    (_settings: unknown, request: JiraBoardIssuePageRequest) =>
      Promise.resolve(
        boardPage(request.scope === 'backlog' ? [backlogIssue] : [sprintIssue, secondSprintIssue])
      )
  )
  mocks.jiraListTransitions.mockResolvedValue([startTransition])
  mocks.jiraUpdateIssue.mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('TaskPageJiraBoard silent reloads', () => {
  it('keeps the rendered cards while a lane drop refetches the sprint', async () => {
    const refetch = holdSprintRefetch(boardPage([sprintIssue, secondSprintIssue]))
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
    const refetch = holdSprintRefetch(boardPage([sprintIssue, secondSprintIssue]))
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

  it('keeps a sprint whose issues a filter hides on screen while it reloads', async () => {
    // Why: a filter that hides every issue is not an empty board, so a reload must not
    // trade the lanes and their empty-state sentence for a loader.
    const refetch = holdSprintRefetch(boardPage([otherAssigneeIssue]))
    render(<RefreshHost />)
    const filteredEmpty = 'No issues match this filter in the active sprint.'
    expect(await screen.findByText(filteredEmpty)).toBeTruthy()

    await act(async () => {
      bumpBoardRefresh()
    })

    await waitFor(() => expect(refetch.sprintCalls()).toBe(2))
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(screen.getByText('Doing')).toBeTruthy()
    expect(screen.getByText(filteredEmpty)).toBeTruthy()

    await act(async () => {
      refetch.resolve(boardPage([otherAssigneeIssue]))
    })
  })

  it('keeps an empty sprint to its empty state while it reloads', async () => {
    // Why: a loaded sprint with no issues and a cleared page both hold nothing, so the
    // loader cannot be inferred from the count — only from having blanked the page.
    const refetch = holdSprintRefetch(boardPage([]))
    render(<RefreshHost />)
    const emptySprint = 'No issues match this filter in the active sprint.'
    expect(await screen.findByText(emptySprint)).toBeTruthy()

    await act(async () => {
      bumpBoardRefresh()
    })

    await waitFor(() => expect(refetch.sprintCalls()).toBe(2))
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(screen.getByText(emptySprint)).toBeTruthy()

    await act(async () => {
      refetch.resolve(boardPage([]))
    })
  })

  it('keeps the loader up when a silent reload supersedes a blanking one', async () => {
    // Why: a cleared page must not count as loaded, or the silent reload landing over it
    // takes the keep-what-is-rendered branch and shows the cleared page as an empty sprint
    // while its own read is still out.
    const refetch = holdSprintRefetch(boardPage([sprintIssue, secondSprintIssue]))
    render(<RefreshHost />)
    await screen.findByText('ABC-1')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh Jira issues' }))
    })
    expect(await screen.findByText('Loading…')).toBeTruthy()

    await act(async () => {
      bumpBoardRefresh()
    })
    expect(screen.getByText('Loading…')).toBeTruthy()
    expect(screen.queryByText('No issues match this filter in the active sprint.')).toBeNull()

    await act(async () => {
      refetch.resolve(boardPage([sprintIssue, secondSprintIssue]))
    })
    expect(await screen.findByText('ABC-1')).toBeTruthy()
  })

  it('disables Load more while a scope read is in flight', async () => {
    const refetch = holdSprintRefetch(
      boardPage([sprintIssue, secondSprintIssue], {
        isLast: false,
        nextPageToken: 'page-2',
        total: 4
      })
    )
    render(<RefreshHost />)
    await screen.findByText('ABC-1')

    await act(async () => {
      bumpBoardRefresh()
    })
    await waitFor(() => expect(refetch.sprintCalls()).toBe(2))

    // Why: a page appended over the reload's answer would write a pre-reload snapshot
    // back over the server's, cache included, so the button must not offer that read.
    // The hook's own guard is belt-and-braces behind the disabled attribute, which is
    // what a click can observe.
    const loadMore = screen.getByRole('button', { name: 'Load more sprint issues' })
    expect(loadMore).toBeDisabled()

    await act(async () => {
      refetch.resolve(
        boardPage([sprintIssue, secondSprintIssue], {
          isLast: false,
          nextPageToken: 'page-2',
          total: 4
        })
      )
    })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Load more sprint issues' })).toBeEnabled()
    )
  })
})
