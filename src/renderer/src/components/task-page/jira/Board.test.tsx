// @vitest-environment happy-dom

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JiraBoardOverview } from '../../../../../shared/jira/jira-types'
import { TaskPageJiraBoard } from './Board'

const mocks = vi.hoisted(() => ({ board: {} as Record<string, unknown> }))

vi.mock('../../use-task-page-jira-board', () => ({
  useTaskPageJiraBoard: () => mocks.board
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => children,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children?: React.ReactNode }) => children
}))

const overview: JiraBoardOverview = {
  board: { id: '9', name: 'Payments board', type: 'scrum' },
  columns: [],
  activeSprints: [{ id: '7', name: 'Sprint 7', state: 'active' }],
  sprints: []
}

function boardState(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    providerSettings: { hostId: null },
    overview,
    overviewLoading: false,
    overviewError: null,
    runtimeBoardUnavailable: false,
    activeSprintId: '7',
    setActiveSprintId: () => {},
    activeSprint: overview.activeSprints[0],
    sprintIssues: [],
    sprintTotal: 0,
    sprintLoading: false,
    sprintBlanked: false,
    sprintLoadingMore: false,
    sprintIsLast: true,
    sprintError: null,
    loadMoreSprint: async () => {},
    backlogIssues: [],
    backlogLoadedCount: 0,
    backlogTotal: null,
    backlogLoading: false,
    backlogBlanked: false,
    backlogLoadingMore: false,
    backlogIsLast: true,
    backlogError: null,
    loadMoreBacklog: async () => {},
    filter: 'all',
    setFilter: () => {},
    query: '',
    setQuery: () => {},
    meFilterReady: true,
    applyIssuePatch: () => {},
    refresh: () => {},
    refreshSilently: () => {},
    ...overrides
  }
}

const model = {
  accountBackedTaskSourceHostId: null,
  jiraTaskSourceContext: null,
  jiraStatus: { sites: [], viewer: null },
  jiraIssueAttachmentIndex: new Map(),
  selectedJiraIssue: null,
  openJiraDetailPage: () => {},
  handleOpenOrUseJiraItem: () => {},
  handleUseJiraItem: () => {},
  getJiraIssueWorkspaces: () => []
} as unknown as Parameters<typeof TaskPageJiraBoard>[0]['model']

function renderBoard(): void {
  render(
    <TaskPageJiraBoard
      model={model}
      selection={{ boardId: '9', siteId: 'site-1', boardName: 'Payments board' }}
      onUseIssueList={() => {}}
      onBoardUnavailable={() => {}}
      onIssueMoved={() => {}}
    />
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('TaskPageJiraBoard sprint columns', () => {
  it('does not claim the sprint is empty when its load failed', () => {
    mocks.board = boardState({ sprintError: 'Jira board read failed.' })

    renderBoard()

    expect(screen.getByRole('alert').textContent).toBe('Jira board read failed.')
    expect(screen.queryByText('No issues match this filter in the active sprint.')).toBeNull()
  })

  it('reports an empty sprint once the read succeeded', () => {
    mocks.board = boardState({})

    renderBoard()

    expect(screen.getByText('No issues match this filter in the active sprint.')).toBeDefined()
  })
})
