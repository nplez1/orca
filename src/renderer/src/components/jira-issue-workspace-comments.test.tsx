// @vitest-environment happy-dom

import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JiraComment } from '../../../shared/jira/jira-types'
import { defaultScopeHost } from '@/lib/default-creation-host'
import { useJiraIssueComments } from './jira-issue-workspace-comments'

const mocks = vi.hoisted(() => ({
  jiraIssueComments: vi.fn(),
  jiraAddIssueComment: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraIssueComments: (...args: unknown[]) => mocks.jiraIssueComments(...args),
  jiraAddIssueComment: (...args: unknown[]) => mocks.jiraAddIssueComment(...args)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback?: string) => fallback ?? _key
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: vi.fn(), message: vi.fn() }
}))

const settings = defaultScopeHost(null)

function readFailure(error: unknown): void {
  mocks.jiraIssueComments.mockRejectedValue(error)
}

function ReadProbe(): React.JSX.Element {
  const state = useJiraIssueComments({
    providerSettings: settings,
    issueKey: 'ABC-1',
    issueSiteId: 'site-1'
  })
  return <div data-testid="error">{state.commentsError ?? 'none'}</div>
}

function SubmitProbe(): React.JSX.Element {
  const state = useJiraIssueComments({
    providerSettings: settings,
    issueKey: 'ABC-1',
    issueSiteId: 'site-1'
  })
  return (
    <>
      <button type="button" onClick={() => state.setCommentDraft('Please look at this')}>
        draft
      </button>
      <button type="button" onClick={() => void state.handleSubmitComment()}>
        send
      </button>
    </>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('useJiraIssueComments error text', () => {
  it('shows Jira’s own reason instead of the Electron invoke wrapper', async () => {
    readFailure(
      new Error(
        "Error invoking remote method 'jira:issueComments': Error: Jira returned 500 for this issue"
      )
    )

    render(<ReadProbe />)

    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toBe('Jira returned 500 for this issue')
    )
  })

  it('falls back to the translated sentence when the failure carries no message', async () => {
    // A rejection that is not an Error at all, so only the fallback can be shown.
    readFailure(undefined)

    render(<ReadProbe />)

    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toBe('Failed to load comments.')
    )
  })

  it('reports a refused comment without its wrapper', async () => {
    mocks.jiraIssueComments.mockResolvedValue([] satisfies JiraComment[])
    mocks.jiraAddIssueComment.mockResolvedValue({
      ok: false,
      error: 'Comment body is required.'
    })
    const user = userEvent.setup()

    render(<SubmitProbe />)
    await user.click(screen.getByRole('button', { name: 'draft' }))
    await user.click(screen.getByRole('button', { name: 'send' }))

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Comment body is required.'))
  })
})
