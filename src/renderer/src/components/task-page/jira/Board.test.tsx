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

const mocks = vi.hoisted(() => ({
  jiraGetBoardOverview: vi.fn(),
  jiraListBoardIssues: vi.fn(),
  jiraListTransitions: vi.fn(),
  jiraUpdateIssue: vi.fn(),
  openSettingsPage: vi.fn(),
  openSettingsTarget: vi.fn()
}))

vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraGetBoardOverview: (...args: unknown[]) => mocks.jiraGetBoardOverview(...args),
  jiraListBoardIssues: (...args: unknown[]) => mocks.jiraListBoardIssues(...args),
  jiraListTransitions: (...args: unknown[]) => mocks.jiraListTransitions(...args),
  jiraUpdateIssue: (...args: unknown[]) => mocks.jiraUpdateIssue(...args)
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      openSettingsPage: mocks.openSettingsPage,
      openSettingsTarget: mocks.openSettingsTarget
    })
}))

function issue(key: string, statusId: string): JiraIssue {
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
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z'
  }
}

const sprintIssue = issue('ABC-1', '1')
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

const model: TaskPageJiraBoardModel = {
  settings: createGlobalSettingsFixture({
    defaultJiraBoard: { boardId: '42', siteId: 'site-1' },
    jiraTeamFieldId: '',
    jiraTeamValue: ''
  }),
  jiraTaskSourceContext: null,
  jiraStatus: {
    connected: true,
    viewer: { accountId: 'viewer-1', displayName: 'Ada', email: null }
  },
  selectedJiraIssue: null,
  openJiraDetailPage: vi.fn(),
  handleUseJiraItem: vi.fn()
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('TaskPageJiraBoard', () => {
  beforeEach(() => {
    mocks.jiraGetBoardOverview.mockResolvedValue({
      board: { id: '42', name: 'Payments', type: 'scrum', siteId: 'site-1', siteName: 'Example' },
      columns: [
        { name: 'Ready', statusIds: ['1'] },
        { name: 'Doing', statusIds: ['3'] }
      ],
      activeSprints: [{ id: '87', name: 'September sprint', state: 'active' }]
    })
    mocks.jiraListBoardIssues.mockImplementation(
      (_settings: unknown, request: JiraBoardIssuePageRequest) =>
        Promise.resolve({
          issues: request.scope === 'backlog' ? [backlogIssue] : [sprintIssue],
          startAt: request.startAt ?? 0,
          nextPageToken: null,
          total: 1,
          isLast: true
        })
    )
    mocks.jiraListTransitions.mockResolvedValue([startTransition])
    mocks.jiraUpdateIssue.mockResolvedValue({ ok: true })
  })

  it('shows the active sprint columns and the full backlog in a separate view', async () => {
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <TaskPageJiraBoard
          model={model}
          selection={{ boardId: '42', siteId: 'site-1' }}
          onUseIssueList={vi.fn()}
          onIssueMoved={vi.fn()}
        />
      </TooltipProvider>
    )

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

  it('opens the backlog instead of an empty sprint view for boards without active sprints', async () => {
    mocks.jiraGetBoardOverview.mockResolvedValue({
      board: { id: '42', name: 'Triage', type: 'kanban', siteId: 'site-1', siteName: 'Example' },
      columns: [{ name: 'To do', statusIds: ['1'] }],
      activeSprints: []
    })
    render(
      <TooltipProvider>
        <TaskPageJiraBoard
          model={model}
          selection={{ boardId: '42', siteId: 'site-1' }}
          onUseIssueList={vi.fn()}
          onIssueMoved={vi.fn()}
        />
      </TooltipProvider>
    )

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
    render(
      <TooltipProvider>
        <TaskPageJiraBoard
          model={model}
          selection={{ boardId: '42', siteId: 'site-1' }}
          onUseIssueList={onUseIssueList}
          onIssueMoved={vi.fn()}
        />
      </TooltipProvider>
    )

    await waitFor(() => expect(onUseIssueList).toHaveBeenCalledOnce())
  })

  it('opens issue details and applies only an available status transition after a drop', async () => {
    const user = userEvent.setup()
    const onIssueMoved = vi.fn()
    render(
      <TooltipProvider>
        <TaskPageJiraBoard
          model={model}
          selection={{ boardId: '42', siteId: 'site-1' }}
          onUseIssueList={vi.fn()}
          onIssueMoved={onIssueMoved}
        />
      </TooltipProvider>
    )

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
