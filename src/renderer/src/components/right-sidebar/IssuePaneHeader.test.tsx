// @vitest-environment happy-dom

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { IssuePaneHeader } from './IssuePaneHeader'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback?: string, options?: Record<string, unknown>) => {
    let value = fallback ?? _key
    for (const [name, replacement] of Object.entries(options ?? {})) {
      value = value.replace(`{{${name}}}`, String(replacement))
    }
    return value
  }
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderHeader(header: React.ReactElement): void {
  render(<TooltipProvider delayDuration={0}>{header}</TooltipProvider>)
}

describe('IssuePaneHeader', () => {
  it('opens the issue through its identifier instead of a launch button', () => {
    const onOpenIssue = vi.fn()
    renderHeader(
      <IssuePaneHeader
        provider="jira"
        identifier="PROJ-1"
        title="Fix checkout"
        openUrl="https://acme.atlassian.net/browse/PROJ-1"
        onRefresh={() => {}}
        onOpenIssue={onOpenIssue}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'PROJ-1' }))

    expect(onOpenIssue).toHaveBeenCalledWith(
      'https://acme.atlassian.net/browse/PROJ-1',
      expect.anything()
    )
    expect(screen.queryByText(/Open on/)).toBeNull()
  })

  it('keeps the identifier inert when there is no URL to open', () => {
    const onOpenIssue = vi.fn()
    renderHeader(
      <IssuePaneHeader
        provider="linear"
        identifier="ENG-7"
        title="Crash"
        openUrl={null}
        onRefresh={() => {}}
        onOpenIssue={onOpenIssue}
      />
    )

    fireEvent.click(screen.getByText('ENG-7'))

    expect(onOpenIssue).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'ENG-7' })).toBeNull()
  })

  it('runs the refresh action', () => {
    const onRefresh = vi.fn()
    renderHeader(
      <IssuePaneHeader
        provider="jira"
        identifier="PROJ-1"
        title="Fix checkout"
        openUrl={null}
        onRefresh={onRefresh}
      />
    )
    fireEvent.click(screen.getByLabelText('Refresh issue'))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('offers unlink and re-link only when the body owns both actions', async () => {
    const user = userEvent.setup()
    const onUnlinkIssue = vi.fn()
    const onLinkAnotherIssue = vi.fn()
    const { rerender } = render(
      <TooltipProvider delayDuration={0}>
        <IssuePaneHeader
          provider="jira"
          identifier="PROJ-1"
          title="Fix checkout"
          openUrl={null}
          onRefresh={() => {}}
        />
      </TooltipProvider>
    )
    expect(screen.queryByLabelText('More issue actions')).toBeNull()

    rerender(
      <TooltipProvider delayDuration={0}>
        <IssuePaneHeader
          provider="jira"
          identifier="PROJ-1"
          title="Fix checkout"
          openUrl={null}
          onRefresh={() => {}}
          onUnlinkIssue={onUnlinkIssue}
          onLinkAnotherIssue={onLinkAnotherIssue}
        />
      </TooltipProvider>
    )
    await user.click(screen.getByLabelText('More issue actions'))
    await user.click(screen.getByRole('menuitem', { name: 'Unlink issue from workspace' }))
    expect(onUnlinkIssue).toHaveBeenCalledTimes(1)

    await user.click(screen.getByLabelText('More issue actions'))
    await user.click(screen.getByRole('menuitem', { name: 'Link another issue' }))
    expect(onLinkAnotherIssue).toHaveBeenCalledTimes(1)
  })

  it('disables the link actions and says why when the workspace cannot store a link edit', async () => {
    const user = userEvent.setup()
    const onUnlinkIssue = vi.fn()
    renderHeader(
      <IssuePaneHeader
        provider="jira"
        identifier="PROJ-1"
        title="Fix checkout"
        openUrl={null}
        onRefresh={() => {}}
        onUnlinkIssue={onUnlinkIssue}
        onLinkAnotherIssue={() => {}}
        linkActionsDisabledReason="A folder workspace keeps the issue it was created from."
      />
    )

    await user.click(screen.getByLabelText('More issue actions'))
    const unlink = screen.getByRole('menuitem', { name: 'Unlink issue from workspace' })
    expect(unlink.getAttribute('data-disabled')).not.toBeNull()
    // Visible, because a disabled item's tooltip can never be reached.
    expect(screen.getByText('A folder workspace keeps the issue it was created from.')).toBeTruthy()

    await user.click(unlink)
    expect(onUnlinkIssue).not.toHaveBeenCalled()
  })
})
