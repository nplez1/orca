// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import { JiraIssueWorkspaceHeader } from './jira-issue-workspace-chrome'
import { JiraIssueWorkspaceContent } from './jira-issue-workspace-content'
import type { JiraIssue } from '../../../shared/jira-types'

function issue(): JiraIssue {
  return {
    id: '1001',
    key: 'ALP-1',
    siteId: 'site-1',
    siteName: 'Example Jira',
    title: 'Payments issue',
    description: 'Body',
    url: 'https://example.atlassian.net/browse/ALP-1',
    project: { id: 'project-1', key: 'ALP', name: 'Payments' },
    issueType: { id: 'story', name: 'Story' },
    status: { id: '1', name: 'To Do', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z'
  }
}

function contentProps(
  attachedWorkspaceLabel: string | null
): Parameters<typeof JiraIssueWorkspaceContent>[0] {
  return {
    displayed: issue(),
    titleDraft: 'Payments issue',
    setTitleDraft: vi.fn(),
    labelsDraft: '',
    setLabelsDraft: vi.fn(),
    handleSaveTitle: vi.fn(),
    handleSaveLabels: vi.fn(),
    pendingField: null,
    comments: [],
    commentsError: null,
    commentsLoading: false,
    retryComments: vi.fn(),
    attachedWorkspaceLabel,
    onOpenOrStartWorkspace: vi.fn(),
    actionItems: []
  }
}

afterEach(cleanup)

describe('Jira issue workspace primary action', () => {
  it('starts a workspace from the header when the issue has none attached', async () => {
    const user = userEvent.setup()
    const onOpenOrStartWorkspace = vi.fn()
    render(
      <TooltipProvider>
        <JiraIssueWorkspaceHeader
          attachedWorkspaceLabel={null}
          displayed={issue()}
          issueLoading={false}
          onOpenOrStartWorkspace={onOpenOrStartWorkspace}
          onClose={vi.fn()}
        />
      </TooltipProvider>
    )

    await user.click(screen.getByRole('button', { name: 'Start workspace' }))
    expect(onOpenOrStartWorkspace).toHaveBeenCalledWith(expect.objectContaining({ key: 'ALP-1' }))
  })

  it('shows the attached workspace from the header instead of starting one', async () => {
    const user = userEvent.setup()
    const onOpenOrStartWorkspace = vi.fn()
    render(
      <TooltipProvider>
        <JiraIssueWorkspaceHeader
          attachedWorkspaceLabel="alp-1-fix-payments"
          displayed={issue()}
          issueLoading={false}
          onOpenOrStartWorkspace={onOpenOrStartWorkspace}
          onClose={vi.fn()}
        />
      </TooltipProvider>
    )

    expect(screen.queryByRole('button', { name: 'Start workspace' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Show workspace' }))
    expect(onOpenOrStartWorkspace).toHaveBeenCalledWith(expect.objectContaining({ key: 'ALP-1' }))
  })

  it('flips the narrow-width action with the attachment too', async () => {
    const user = userEvent.setup()
    const detached = contentProps(null)
    const { rerender } = render(
      <TooltipProvider>
        <JiraIssueWorkspaceContent {...detached} />
      </TooltipProvider>
    )

    await user.click(screen.getByRole('button', { name: 'Start workspace' }))
    expect(detached.onOpenOrStartWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'ALP-1' })
    )

    const attached = contentProps('alp-1-fix-payments')
    rerender(
      <TooltipProvider>
        <JiraIssueWorkspaceContent {...attached} />
      </TooltipProvider>
    )

    expect(screen.queryByRole('button', { name: 'Start workspace' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Show workspace' }))
    expect(attached.onOpenOrStartWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'ALP-1' })
    )
  })
})
