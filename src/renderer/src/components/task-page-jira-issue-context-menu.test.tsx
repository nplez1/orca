// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@/components/ui/tooltip'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { TaskPageJiraIssueList } from './task-page-jira-issue-list'
import type { JiraIssue } from '../../../shared/jira/jira-types'

const openUrl = vi.fn()
const { openAppHttpLink } = vi.hoisted(() => ({ openAppHttpLink: vi.fn() }))
// LOCAL(nplez1): #234 routes the link through this entry point, not straight to the shell bridge.
vi.mock('@/lib/app-http-link-open', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openAppHttpLink
}))
const writeClipboardText = vi.fn().mockResolvedValue(undefined)
const onOpenIssue = vi.fn()
const onStartWorkspace = vi.fn()
const onOpenOrStartWorkspace = vi.fn()

const issue: JiraIssue = {
  id: '1',
  key: 'APP-1',
  siteId: 'site-a',
  title: 'Fix login',
  url: 'https://acme.atlassian.net/browse/APP-1',
  project: { id: '1', key: 'APP', name: 'App' },
  issueType: { id: '1', name: 'Bug' },
  status: { id: '1', name: 'Open', categoryKey: 'new', categoryName: 'Open' },
  labels: [],
  createdAt: '2026-10-01',
  updatedAt: '2026-10-01'
}
const linkedWorkspace = makeWorktree({ id: 'first', repoId: 'api', displayName: 'APP-1 fix login' })

type ListProps = ComponentProps<typeof TaskPageJiraIssueList>

function renderList(overrides: Partial<ListProps> = {}) {
  return render(
    <TooltipProvider>
      <TaskPageJiraIssueList
        issues={[issue]}
        selectedIssue={null}
        showSiteContext={false}
        statusOrder={null}
        formatUpdatedAt={() => 'Today'}
        getStatusTone={() => ''}
        onOpenIssue={onOpenIssue}
        onOpenOrStartWorkspace={onOpenOrStartWorkspace}
        onStartWorkspace={onStartWorkspace}
        {...overrides}
      />
    </TooltipProvider>
  )
}

async function openRowMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.pointer({ keys: '[MouseRight]', target: screen.getByText('Fix login') })
  return screen.getByRole('menu')
}

beforeEach(() => {
  // LOCAL(nplez1): #234 routes the issue link through the in-app router, whose system fallback is
  // the explicit variant, so `openUrl` is no longer reached.
  Object.assign(window, {
    api: { shell: { openUrl, openUrlInSystemBrowser: openUrl }, ui: { writeClipboardText } }
  })
  vi.clearAllMocks()
  localStorage.clear()
})
afterEach(cleanup)

describe('Jira task row context menu', () => {
  it('offers every action the detail sheet declares, in one list', async () => {
    renderList()
    const user = userEvent.setup()
    const menu = await openRowMenu(user)
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

  it('reads Show workspace when the issue already has a workspace', async () => {
    renderList({ getIssueWorkspaces: () => [linkedWorkspace] })
    const user = userEvent.setup()
    const menu = await openRowMenu(user)
    expect(within(menu).getByRole('menuitem', { name: 'Show workspace' })).toBeInTheDocument()
    expect(within(menu).queryByRole('menuitem', { name: 'Start workspace' })).toBeNull()
  })

  it('opens the workspace composer without opening the issue', async () => {
    renderList()
    const user = userEvent.setup()
    const menu = await openRowMenu(user)
    await user.click(within(menu).getByRole('menuitem', { name: 'Start workspace' }))
    expect(onOpenOrStartWorkspace).toHaveBeenCalledWith(issue)
    expect(onOpenIssue).not.toHaveBeenCalled()
  })

  it('falls back to the plain start handler when only that one is wired', async () => {
    renderList({ onOpenOrStartWorkspace: undefined })
    const user = userEvent.setup()
    const menu = await openRowMenu(user)
    await user.click(within(menu).getByRole('menuitem', { name: 'Start workspace' }))
    expect(onStartWorkspace).toHaveBeenCalledWith(issue)
    expect(onOpenIssue).not.toHaveBeenCalled()
  })

  it('opens the issue in Jira without opening the detail sheet', async () => {
    renderList()
    const user = userEvent.setup()
    const menu = await openRowMenu(user)
    await user.click(within(menu).getByRole('menuitem', { name: 'Open in Jira' }))
    expect(openAppHttpLink).toHaveBeenCalledWith(issue.url)
    expect(onOpenIssue).not.toHaveBeenCalled()
  })

  it('copies the suggested branch name', async () => {
    renderList()
    const user = userEvent.setup()
    const menu = await openRowMenu(user)
    await user.click(within(menu).getByRole('menuitem', { name: 'Copy suggested branch name' }))
    expect(writeClipboardText).toHaveBeenCalledWith('app-1-fix-login')
  })

  it('does not activate, select, or navigate the row on right-click', async () => {
    renderList()
    const user = userEvent.setup()
    await openRowMenu(user)
    expect(onOpenIssue).not.toHaveBeenCalled()
  })

  it('keeps the row reachable from the keyboard', async () => {
    renderList()
    const row = screen.getByRole('button', { name: /Fix login/ })
    expect(row).toHaveAttribute('aria-keyshortcuts', 'Enter Space Shift+F10 ContextMenu')
  })

  it('opens from the keyboard on a focused row', async () => {
    renderList()
    const user = userEvent.setup()
    const row = screen.getByRole('button', { name: /Fix login/ })
    row.focus()
    await user.keyboard('{Shift>}{F10}{/Shift}')
    expect(screen.getByRole('menuitem', { name: 'Start workspace' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Copy key' })).toBeInTheDocument()
    expect(onOpenIssue).not.toHaveBeenCalled()
  })
})
