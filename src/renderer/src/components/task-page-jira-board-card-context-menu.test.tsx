// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { JiraIssue } from '../../../shared/jira/jira-types'
import { TaskPageJiraBoard } from './task-page-jira-board'

const openUrl = vi.fn()
const writeClipboardText = vi.fn().mockResolvedValue(undefined)
const onOpenIssue = vi.fn()
const onStartWorkspace = vi.fn()

const issue: JiraIssue = {
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
  updatedAt: '2026-10-01'
}

function renderBoard() {
  return render(
    <TooltipProvider>
      <TaskPageJiraBoard
        formatUpdatedAt={() => 'Today'}
        issues={[issue]}
        onMoveIssue={async () => {}}
        onOpenIssue={onOpenIssue}
        onStartWorkspace={onStartWorkspace}
        selectedIssue={null}
        showSiteContext={false}
        statusOrder={null}
        updatingIssueKeys={new Set()}
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

describe('Jira status board card context menu', () => {
  it('offers the row actions on the card', async () => {
    renderBoard()
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

  it('starts a workspace without opening the issue', async () => {
    renderBoard()
    const user = userEvent.setup()
    const menu = await openCardMenu(user)
    await user.click(within(menu).getByRole('menuitem', { name: 'Start workspace' }))
    expect(onStartWorkspace).toHaveBeenCalledWith(issue)
    expect(onOpenIssue).not.toHaveBeenCalled()
  })

  it('opens the card menu from the keyboard', async () => {
    renderBoard()
    const user = userEvent.setup()
    const card = screen.getByRole('button', { name: /Fix login/ })
    card.focus()
    await user.keyboard('{Shift>}{F10}{/Shift}')
    expect(screen.getByRole('menuitem', { name: 'Copy key' })).toBeInTheDocument()
    expect(onOpenIssue).not.toHaveBeenCalled()
  })
})
