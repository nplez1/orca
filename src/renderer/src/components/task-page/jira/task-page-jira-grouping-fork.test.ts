// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { TooltipProvider } from '@/components/ui/tooltip'
import { buildJiraIssueWorkspaceAttachmentIndex } from '@/lib/jira-issue-workspace-attachment'

import { TaskPageJiraIssueList } from './task-page-jira-issue-list'

import type { JiraIssue } from '../../../../../shared/jira/jira-types'
import type { Worktree } from '../../../../../shared/worktree/types'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function jiraIssue(
  key: string,
  title: string,
  statusId: string,
  statusName: string,
  options: { priority?: string } = {}
): JiraIssue {
  return {
    id: `site-1:${key}`,
    key,
    title,
    url: `https://example.atlassian.net/browse/${key}`,
    siteId: 'site-1',
    siteName: 'Example Jira',
    project: { id: 'ALP', key: 'ALP', name: 'ALP', siteId: 'site-1' },
    issueType: { id: '10001', name: 'Bug' },
    status: { id: statusId, name: statusName, categoryKey: 'new', categoryName: statusName },
    priority: options.priority ? { id: options.priority, name: options.priority } : undefined,
    labels: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

const EMPTY_ATTACHMENT_INDEX = buildJiraIssueWorkspaceAttachmentIndex([])

function attachedWorkspace(key: string, displayName: string): Worktree {
  return {
    id: 'wt-attached',
    repoId: 'repo-1',
    path: '/tmp/repo-1/wt-attached',
    head: 'abc123',
    branch: 'refs/heads/alp-1-fix-payments',
    isBare: false,
    isMainWorktree: false,
    displayName,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedWorkItem: {
      provider: 'jira',
      type: 'issue',
      number: 0,
      title: key,
      url: `https://example.atlassian.net/browse/${key}`,
      jiraIdentifier: key
    },
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

describe('Jira issue list fork presentation', () => {
  it('marks blocker tasks with a severity chip and a red surface wash', () => {
    render(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(TaskPageJiraIssueList, {
          formatUpdatedAt: () => 'today',
          getStatusTone: () => 'border-border',
          issues: [
            jiraIssue('ALP-1', 'Blocker issue', '1', 'To Do', { priority: 'Blocker' }),
            jiraIssue('ALP-2', 'Critical issue', '1', 'To Do', { priority: 'Critical' }),
            jiraIssue('ALP-3', 'Major issue', '1', 'To Do', { priority: 'Major' }),
            jiraIssue('ALP-4', 'Unranked issue', '1', 'To Do')
          ],
          onOpenIssue: vi.fn(),
          onOpenOrStartWorkspace: vi.fn(),
          issueWorkspaceAttachmentIndex: EMPTY_ATTACHMENT_INDEX,
          selectedIssue: null,
          showSiteContext: false,
          statusOrder: null
        })
      )
    )

    const blockerRow = screen.getByText('Blocker issue').closest('[role="button"]')
    expect(blockerRow?.className).toContain('bg-jira-priority-high/10')
    expect(blockerRow?.className).toContain('hover:bg-jira-priority-high/15')

    const majorRow = screen.getByText('Major issue').closest('[role="button"]')
    expect(majorRow?.className).not.toContain('bg-jira-priority-high/10')
    expect(majorRow?.className).toContain('hover:bg-accent')

    // Critical shares the blocker's red chip but must not inherit the surface wash — the
    // wash is the only thing telling the two tiers apart.
    const criticalRow = screen.getByText('Critical issue').closest('[role="button"]')
    expect(criticalRow?.className).not.toContain('bg-jira-priority-high/10')
    expect(criticalRow?.className).toContain('hover:bg-accent')

    const chip = (name: string): Element | null =>
      screen.getAllByText(name)[0]?.closest('[data-severity]') ?? null
    expect(chip('Blocker')?.getAttribute('data-severity')).toBe('blocker')
    expect(chip('Blocker')?.className).toContain('text-jira-priority-high')
    expect(chip('Critical')?.getAttribute('data-severity')).toBe('critical')
    expect(chip('Critical')?.className).toContain('text-jira-priority-high')
    expect(chip('Major')?.getAttribute('data-severity')).toBe('major')
    // Why high and not medium: the chip reads the shared priority palette the issue-list cells
    // use, and that palette puts major in the high tier — one vocabulary for both surfaces.
    expect(chip('Major')?.className).toContain('text-jira-priority-high')
    expect(chip('No priority')?.getAttribute('data-severity')).toBe('standard')
  })

  it('shows an attached-workspace chip and flips the row action to Show workspace', async () => {
    const user = userEvent.setup()
    const onOpenOrStartWorkspace = vi.fn()
    render(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(TaskPageJiraIssueList, {
          formatUpdatedAt: () => 'today',
          getStatusTone: () => 'border-border',
          issues: [
            jiraIssue('ALP-1', 'Attached issue', '1', 'To Do'),
            jiraIssue('ALP-2', 'Unattached issue', '1', 'To Do')
          ],
          issueWorkspaceAttachmentIndex: buildJiraIssueWorkspaceAttachmentIndex([
            attachedWorkspace('ALP-1', 'Attached workspace')
          ]),
          onOpenIssue: vi.fn(),
          onOpenOrStartWorkspace,
          selectedIssue: null,
          showSiteContext: false,
          statusOrder: null,
          groupByStatus: false
        })
      )
    )

    // One chip, on the title line, at every width.
    expect(screen.getByText('Attached workspace')).toBeInTheDocument()

    // The action flips only for the row whose issue has a workspace.
    const attachedAction = screen.getByLabelText('Open workspace attached to ALP-1')
    expect(screen.getByLabelText('Start workspace from ALP-2')).toBeInTheDocument()

    await user.click(attachedAction)
    expect(onOpenOrStartWorkspace).toHaveBeenCalledWith(expect.objectContaining({ key: 'ALP-1' }))
    expect(attachedAction.querySelector('.lucide-folder-open')).not.toBeNull()
  })
})
