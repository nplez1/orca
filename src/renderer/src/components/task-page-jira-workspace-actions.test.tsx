// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TaskPageJiraIssueList } from './task-page-jira-issue-list'
import { defaultJiraListColumnIds, visibleJiraListColumns } from './jira-list-columns'
import type { JiraIssue } from '../../../shared/jira/jira-types'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'

const issue: JiraIssue = {
  id: '1',
  key: 'APP-1',
  siteId: 'site-a',
  title: 'Fix login',
  url: 'https://acme.atlassian.net/browse/APP-1',
  project: { id: '1', key: 'APP', name: 'App' },
  issueType: { id: '1', name: 'Bug' },
  status: {
    id: '1',
    name: 'In Progress',
    categoryKey: 'indeterminate',
    categoryName: 'In Progress'
  },
  labels: [],
  createdAt: '2026-10-01',
  updatedAt: '2026-10-01'
}
const first = makeWorktree({ id: 'first', repoId: 'api', displayName: 'API fix' })
const second = makeWorktree({ id: 'second', repoId: 'web', displayName: 'UI fix' })
// The row receives a scoped lookup so the UI cannot accidentally match bare keys.
const onOpenWorkspace = vi.fn()
const onOpenIssue = vi.fn()
const onStartWorkspace = vi.fn()
const onOpenOrStartWorkspace = vi.fn()
function renderList(workspaces = [first, second]) {
  const props = {
    columns: visibleJiraListColumns(defaultJiraListColumnIds()),
    issues: [issue],
    selectedIssue: null,
    showSiteContext: false,
    statusOrder: null,
    formatUpdatedAt: () => 'Today',
    getStatusTone: () => '',
    onOpenIssue,
    onStartWorkspace,
    onOpenOrStartWorkspace,
    getIssueWorkspaces: () => workspaces,
    onOpenWorkspace
  }
  return render(
    <TooltipProvider>
      <TaskPageJiraIssueList {...props} />
    </TooltipProvider>
  )
}
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
describe('Jira linked workspace split action', () => {
  it('opens the linked workspace on default click of the button body', async () => {
    renderList([first])
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Open workspace attached to APP-1' }))
    expect(onOpenOrStartWorkspace).toHaveBeenCalledWith(issue)
    expect(onOpenWorkspace).not.toHaveBeenCalled()
  })

  it('lists every linked workspace and opens the selected one from the caret', async () => {
    renderList()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '2 workspaces linked to APP-1' }))
    await user.click(await screen.findByRole('menuitem', { name: /UI fix/ }))
    expect(onOpenWorkspace).toHaveBeenCalledWith(second)
  })

  it('offers Start new workspace when exactly one workspace is linked', async () => {
    renderList([first])
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '1 workspace linked to APP-1' }))
    expect(onOpenWorkspace).not.toHaveBeenCalled()
    expect(await screen.findByRole('menuitem', { name: /API fix/ })).toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: 'Start new workspace' }))
    expect(onStartWorkspace).toHaveBeenCalledWith(issue)
    expect(onOpenIssue).not.toHaveBeenCalled()
  })

  it('opens the same menu on press-and-hold of the body without firing the default click', async () => {
    renderList([first])
    const user = userEvent.setup()
    const body = screen.getByRole('button', { name: 'Open workspace attached to APP-1' })
    fireEvent.pointerDown(body)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550))
    })
    expect(screen.getByRole('menuitem', { name: /API fix/ })).toBeInTheDocument()
    fireEvent.pointerUp(body)
    expect(onOpenOrStartWorkspace).not.toHaveBeenCalled()
    // The open menu swallows the release click, so the onClick guard never clears
    // heldRef here; the next activation after dismissal must still fire.
    await user.keyboard('{Escape}')
    fireEvent.click(body)
    expect(onOpenOrStartWorkspace).toHaveBeenCalledWith(issue)
  })

  it('does not open the menu on a secondary-button press held past the hold window', async () => {
    renderList([first])
    const body = screen.getByRole('button', { name: 'Open workspace attached to APP-1' })
    fireEvent.pointerDown(body, { button: 2 })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550))
    })
    fireEvent.pointerUp(body, { button: 2 })
    expect(screen.queryByRole('menuitem', { name: /API fix/ })).not.toBeInTheDocument()
    expect(onOpenOrStartWorkspace).not.toHaveBeenCalled()
  })

  it('does not open the menu on a ctrl+click press held past the hold window (macOS right-click)', async () => {
    renderList([first])
    const body = screen.getByRole('button', { name: 'Open workspace attached to APP-1' })
    fireEvent.pointerDown(body, { button: 0, ctrlKey: true })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550))
    })
    fireEvent.pointerUp(body, { button: 0, ctrlKey: true })
    expect(screen.queryByRole('menuitem', { name: /API fix/ })).not.toBeInTheDocument()
    expect(onOpenOrStartWorkspace).not.toHaveBeenCalled()
  })

  it('does not open the menu on a touch long-press of the body', async () => {
    renderList([first])
    const body = screen.getByRole('button', { name: 'Open workspace attached to APP-1' })
    fireEvent.pointerDown(body, { button: 0, pointerType: 'touch' })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550))
    })
    fireEvent.pointerUp(body, { button: 0, pointerType: 'touch' })
    expect(screen.queryByRole('menuitem', { name: /API fix/ })).not.toBeInTheDocument()
    expect(onOpenOrStartWorkspace).not.toHaveBeenCalled()
  })

  it('keeps a plain start button for an unlinked issue', async () => {
    renderList([])
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Start workspace from APP-1' }))
    expect(onOpenOrStartWorkspace).toHaveBeenCalledWith(issue)
    // No linked workspace means no caret dropdown.
    expect(screen.queryByRole('button', { name: /workspaces? linked/ })).not.toBeInTheDocument()
  })
})
