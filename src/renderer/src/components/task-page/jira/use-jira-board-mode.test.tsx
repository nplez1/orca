// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { useJiraBoardMode } from './use-jira-board-mode'

const STORAGE_KEY = 'orca.jira.board-view.v1'

function model(overrides: Partial<TaskPageComposerActionsModel>): TaskPageComposerActionsModel {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This harness supplies every field the board mode reads.
  return {
    selectedJiraIssue: null,
    jiraDetailSourceContext: null,
    jiraTaskSourceContext: null,
    accountBackedTaskSourceHostId: 'local',
    setJiraRefreshNonce: vi.fn(),
    jiraBoardViewMode: 'board',
    setJiraBoardViewMode: vi.fn(),
    jiraIssueAttachmentIndex: {},
    handleOpenOrUseJiraItem: vi.fn(),
    settings: { defaultJiraBoard: { boardId: '42', siteId: 'site-1', name: 'Payments' } },
    ...overrides
  } as unknown as TaskPageComposerActionsModel
}

function Harness({ state }: { state: TaskPageComposerActionsModel }): React.JSX.Element {
  const boardMode = useJiraBoardMode(state)
  return (
    <div>
      <output data-testid="active-board">{boardMode.activeBoard?.boardId ?? 'none'}</output>
      <button type="button" onClick={boardMode.reportRuntimeBoardUnavailable}>
        runtime-missing
      </button>
      <button type="button" onClick={boardMode.retryBoard}>
        retry
      </button>
      <button type="button" onClick={boardMode.showIssueList}>
        user-list
      </button>
    </div>
  )
}

function activeBoard(): string | null {
  return screen.getByTestId('active-board').textContent
}

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('useJiraBoardMode', () => {
  it('falls back to the issue list in memory when the runtime cannot serve the board', () => {
    const state = model({})
    render(<Harness state={state} />)
    expect(activeBoard()).toBe('42')

    fireEvent.click(screen.getByRole('button', { name: 'runtime-missing' }))

    expect(activeBoard()).toBe('none')
    // Why the assertion: recording the capability miss as a view preference is what left a
    // device on the issue list for good, with nothing but a toast to explain it.
    expect(state.setJiraBoardViewMode).not.toHaveBeenCalled()
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('brings the board back on retry once the runtime supports it', () => {
    render(<Harness state={model({})} />)

    fireEvent.click(screen.getByRole('button', { name: 'runtime-missing' }))
    expect(activeBoard()).toBe('none')

    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    expect(activeBoard()).toBe('42')
  })

  it("drops a host's capability miss when the serving runtime changes", () => {
    const state = model({})
    const { rerender } = render(<Harness state={state} />)

    fireEvent.click(screen.getByRole('button', { name: 'runtime-missing' }))
    expect(activeBoard()).toBe('none')

    rerender(<Harness state={{ ...state, accountBackedTaskSourceHostId: 'runtime:upgraded' }} />)

    expect(activeBoard()).toBe('42')
  })

  it('still records an explicit switch to the issue list', () => {
    const state = model({})
    render(<Harness state={state} />)

    fireEvent.click(screen.getByRole('button', { name: 'user-list' }))

    expect(state.setJiraBoardViewMode).toHaveBeenCalledWith('list')
  })
})
