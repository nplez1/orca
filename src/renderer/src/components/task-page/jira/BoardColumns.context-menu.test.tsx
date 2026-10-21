// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { JiraIssue } from '../../../../../shared/jira-types'
import { buildJiraIssueWorkspaceAttachmentIndex } from '@/lib/jira-issue-workspace-attachment'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { TaskPageJiraBoardColumns } from './BoardColumns'

const openUrl = vi.fn()
const writeClipboardText = vi.fn().mockResolvedValue(undefined)
const onOpenIssue = vi.fn()
const onStartWorkspace = vi.fn()
const onOpenOrStartWorkspace = vi.fn()

function issue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: '1',
    key: 'APP-1',
    siteId: 'site-1',
    title: 'Fix login',
    url: 'https://acme.atlassian.net/browse/APP-1',
    project: { id: '1', key: 'APP', name: 'App' },
    issueType: { id: '1', name: 'Bug' },
    status: { id: '1', name: 'To Do', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    createdAt: '2026-10-01',
    updatedAt: '2026-10-01',
    ...overrides
  }
}

const noop = () => undefined

const linkedWorkspace = makeWorktree({
  id: 'wt-1',
  repoId: 'repo',
  displayName: 'app-1-fix-login',
  linkedItems: [
    {
      provider: 'jira',
      type: 'issue',
      number: 0,
      identifier: 'APP-1',
      title: 'Fix login',
      url: 'https://acme.atlassian.net/browse/APP-1'
    }
  ]
})

function renderColumns(card = issue(), linkedIndex = buildJiraIssueWorkspaceAttachmentIndex([])) {
  return render(
    <TooltipProvider>
      <TaskPageJiraBoardColumns
        columns={[{ column: { name: 'To Do', statusIds: ['1'] }, issues: [card] }]}
        otherIssues={[]}
        selectedIssue={null}
        issueWorkspaceAttachmentIndex={linkedIndex}
        sourceContext={null}
        draggingIssueKey={null}
        updatingIssueKeys={[]}
        dragOverColumnKey={null}
        onOpenIssue={onOpenIssue}
        onOpenOrStartWorkspace={onOpenOrStartWorkspace}
        onStartWorkspace={onStartWorkspace}
        onDragStart={noop}
        onDragEnd={noop}
        onDragOver={noop}
        onDrop={noop}
        onDragOverOther={noop}
        onDropOther={noop}
      />
    </TooltipProvider>
  )
}

async function openCardMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.pointer({ keys: '[MouseRight]', target: screen.getByText('Fix login') })
  return screen.getByRole('menu')
}

beforeEach(() => {
  Object.assign(window, { api: { shell: { openUrl }, ui: { writeClipboardText } } })
  vi.clearAllMocks()
  localStorage.clear()
})
afterEach(cleanup)

describe('Jira board card context menu', () => {
  it('carries the same actions as a task row', async () => {
    renderColumns()
    const user = userEvent.setup()
    const menu = await openCardMenu(user)
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
    ).toEqual([
      'Start workspace',
      'Open in Jira',
      'Copy URL',
      'Copy key',
      'Copy suggested branch name',
      'Copy prompt',
      'Copy prompt from template'
    ])
  })

  it('does not open the issue when the card is right-clicked', async () => {
    renderColumns()
    const user = userEvent.setup()
    await openCardMenu(user)
    expect(onOpenIssue).not.toHaveBeenCalled()
  })

  it('starts a workspace from the card without opening the issue', async () => {
    renderColumns()
    const user = userEvent.setup()
    const menu = await openCardMenu(user)
    await user.click(within(menu).getByRole('menuitem', { name: 'Start workspace' }))
    expect(onOpenOrStartWorkspace).toHaveBeenCalledWith(expect.objectContaining({ key: 'APP-1' }))
    expect(onOpenIssue).not.toHaveBeenCalled()
  })

  it('reads Show workspace when the card already has a workspace', async () => {
    renderColumns(issue(), buildJiraIssueWorkspaceAttachmentIndex([linkedWorkspace]))
    const user = userEvent.setup()
    const menu = await openCardMenu(user)
    expect(within(menu).getByRole('menuitem', { name: 'Show workspace' })).toBeInTheDocument()
    expect(within(menu).queryByRole('menuitem', { name: 'Start workspace' })).toBeNull()
  })

  it('opens the card menu from the keyboard', async () => {
    renderColumns()
    const user = userEvent.setup()
    const card = screen.getByRole('button', { name: /Fix login/ })
    card.focus()
    await user.keyboard('{Shift>}{F10}{/Shift}')
    expect(screen.getByRole('menuitem', { name: 'Copy key' })).toBeInTheDocument()
    expect(onOpenIssue).not.toHaveBeenCalled()
  })

  it('keeps Enter opening the issue', async () => {
    renderColumns()
    const user = userEvent.setup()
    const card = screen.getByRole('button', { name: /Fix login/ })
    card.focus()
    await user.keyboard('{Enter}')
    expect(onOpenIssue).toHaveBeenCalledWith(expect.objectContaining({ key: 'APP-1' }))
  })
})
