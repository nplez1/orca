// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TaskPageJiraIssueList } from './task-page-jira-issue-list'
import { defaultJiraListColumnIds, visibleJiraListColumns } from './jira-list-columns'
import type { JiraIssue } from '../../../shared/jira/jira-types'
const writeClipboardText = vi.fn().mockResolvedValue(undefined)
const issue: JiraIssue = {
  id: '1',
  key: 'APP-1',
  title: 'Fix login',
  url: 'https://acme.atlassian.net/browse/APP-1',
  project: { id: '1', key: 'APP', name: 'App' },
  issueType: { id: '1', name: 'Bug' },
  status: { id: '1', name: 'Open', categoryKey: 'new', categoryName: 'Open' },
  labels: [],
  createdAt: '2026-10-01',
  updatedAt: '2026-10-01'
}
const onOpenIssue = vi.fn()
function renderList() {
  return render(
    <TooltipProvider>
      <TaskPageJiraIssueList
        columns={visibleJiraListColumns(defaultJiraListColumnIds())}
        issues={[issue]}
        selectedIssue={null}
        showSiteContext={false}
        statusOrder={null}
        formatUpdatedAt={() => 'Today'}
        getStatusTone={() => ''}
        onOpenIssue={onOpenIssue}
        onStartWorkspace={vi.fn()}
      />
    </TooltipProvider>
  )
}
async function openCopyContextMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.pointer({ keys: '[MouseRight]', target: screen.getByText('Fix login') })
}
async function openTemplatePicker(user: ReturnType<typeof userEvent.setup>) {
  await openCopyContextMenu(user)
  await user.click(screen.getByRole('menuitem', { name: 'Copy prompt from template' }))
}
beforeEach(() => {
  Object.assign(window, { api: { ui: { writeClipboardText } } })
  vi.clearAllMocks()
  localStorage.clear()
})
afterEach(cleanup)
describe('Jira row quick copy', () => {
  it('offers the same copy actions in the row context menu', async () => {
    renderList()
    const user = userEvent.setup()
    await openCopyContextMenu(user)
    await user.click(screen.getByRole('menuitem', { name: 'Copy URL' }))
    expect(writeClipboardText).toHaveBeenCalledWith(issue.url)
    expect(onOpenIssue).not.toHaveBeenCalled()
  })

  it('renders a template preview with additional instructions and copies it', async () => {
    renderList()
    const user = userEvent.setup()
    await openTemplatePicker(user)
    await user.type(
      screen.getByLabelText('Additional instructions (optional)'),
      'Cover SSH behavior.'
    )
    const preview = screen.getByLabelText('Preview')
    expect(preview).toBeInstanceOf(HTMLTextAreaElement)
    if (!(preview instanceof HTMLTextAreaElement)) {
      throw new Error('Expected a textarea preview')
    }
    expect(preview.value).toContain('Cover SSH behavior.')
    await user.click(screen.getByRole('button', { name: 'Copy prompt' }))
    expect(writeClipboardText).toHaveBeenCalledWith(expect.stringContaining('APP-1'))
    expect(writeClipboardText).toHaveBeenCalledWith(expect.stringContaining('Cover SSH behavior.'))
    expect(
      screen.queryByRole('dialog', { name: 'Copy prompt from template' })
    ).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: /Fix login/ })).toHaveFocus())
  })

  it('reuses a custom template after closing and reopening the picker', async () => {
    renderList()
    const user = userEvent.setup()
    async function openCustomTemplate() {
      await openTemplatePicker(user)
      await user.click(screen.getByRole('combobox', { name: 'Template' }))
      await user.click(screen.getByRole('option', { name: 'Custom template' }))
    }
    await openCustomTemplate()
    await user.clear(screen.getByLabelText('Template text'))
    await user.type(screen.getByLabelText('Template text'), 'Review $jira-issue')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await openCustomTemplate()
    expect(screen.getByLabelText('Template text')).toHaveValue('Review $jira-issue')
    await user.click(screen.getByRole('button', { name: 'Copy prompt' }))
    expect(writeClipboardText).toHaveBeenCalledWith(
      `Review Complete Jira issue APP-1: Fix login\n\n${issue.url}`
    )
  })

  it('keeps the template picker open when the clipboard write fails', async () => {
    writeClipboardText.mockRejectedValueOnce(new Error('Clipboard unavailable'))
    renderList()
    const user = userEvent.setup()
    await openTemplatePicker(user)
    await user.click(screen.getByRole('button', { name: 'Copy prompt' }))
    expect(screen.getByRole('dialog', { name: 'Copy prompt from template' })).toBeInTheDocument()
  })

  it('copies the key from the row without opening the issue', async () => {
    renderList()
    const user = userEvent.setup()
    await openCopyContextMenu(user)
    await user.click(screen.getByRole('menuitem', { name: 'Copy key' }))
    expect(writeClipboardText).toHaveBeenCalledWith('APP-1')
    expect(onOpenIssue).not.toHaveBeenCalled()
  })

  it('reaches the copy menu from the keyboard via Shift+F10', async () => {
    renderList()
    const user = userEvent.setup()
    const row = screen.getByRole('button', { name: /Fix login/ })
    row.focus()
    expect(row).toHaveFocus()
    await user.keyboard('{Shift>}{F10}{/Shift}')
    expect(screen.getByRole('menuitem', { name: 'Copy key' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Copy URL' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Copy prompt' })).toBeInTheDocument()
    expect(onOpenIssue).not.toHaveBeenCalled()
  })

  it('keeps Enter and Space opening the issue', async () => {
    renderList()
    const user = userEvent.setup()
    const row = screen.getByRole('button', { name: /Fix login/ })
    row.focus()
    await user.keyboard('{Enter}')
    expect(onOpenIssue).toHaveBeenCalledWith(issue)
    onOpenIssue.mockClear()
    row.focus()
    await user.keyboard(' ')
    expect(onOpenIssue).toHaveBeenCalledWith(issue)
  })
})
