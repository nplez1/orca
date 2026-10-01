// @vitest-environment happy-dom

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

function stubShellOpenUrl(): ReturnType<typeof vi.fn> {
  const openUrl = vi.fn()
  Object.defineProperty(window, 'api', {
    value: { shell: { openUrl } },
    configurable: true,
    writable: true
  })
  return openUrl
}

function renderHeader(header: React.ReactElement): void {
  render(<TooltipProvider delayDuration={0}>{header}</TooltipProvider>)
}

describe('IssuePaneHeader', () => {
  it('names the provider on the launch button and opens its URL', () => {
    const openUrl = stubShellOpenUrl()
    renderHeader(
      <IssuePaneHeader
        provider="jira"
        identifier="PROJ-1"
        title="Fix checkout"
        openUrl="https://acme.atlassian.net/browse/PROJ-1"
        onRefresh={() => {}}
      />
    )

    fireEvent.click(screen.getByText('Open in Jira'))
    expect(openUrl).toHaveBeenCalledWith('https://acme.atlassian.net/browse/PROJ-1')
  })

  it('names each provider and omits the button when there is no URL', () => {
    stubShellOpenUrl()
    const renderTree = (
      provider: 'github' | 'linear',
      openUrl: string | null
    ): React.ReactElement => (
      <IssuePaneHeader
        provider={provider}
        identifier="#7"
        title="Crash"
        openUrl={openUrl}
        onRefresh={() => {}}
      />
    )
    const { rerender } = render(
      <TooltipProvider delayDuration={0}>
        {renderTree('github', 'https://github.com/acme/orca/issues/7')}
      </TooltipProvider>
    )
    expect(screen.getByText('Open in GitHub')).toBeTruthy()

    rerender(
      <TooltipProvider delayDuration={0}>
        {renderTree('linear', 'https://linear.app/acme/issue/ENG-7')}
      </TooltipProvider>
    )
    expect(screen.getByText('Open in Linear')).toBeTruthy()

    rerender(<TooltipProvider delayDuration={0}>{renderTree('linear', null)}</TooltipProvider>)
    expect(screen.queryByText(/Open in/)).toBeNull()
  })

  it('runs the refresh action', () => {
    stubShellOpenUrl()
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
})
