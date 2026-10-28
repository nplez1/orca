import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import StatusIndicator, { type Status } from './StatusIndicator'

// Why this file survives upstream retiring its StatusIndicator suite (#34156): the `setup` state is
// the fork's, so upstream's removal took the only coverage of it with it.
vi.mock('@/components/StateIndicatorTooltip', async () => {
  const { createElement } = await import('react')
  return {
    StateIndicatorTooltip: ({
      label,
      children
    }: {
      label: string | null
      children: React.ReactElement
    }) =>
      label === null
        ? children
        : createElement('span', { 'data-state-indicator-tooltip': label }, children)
  }
})

function renderMarkup(status: Status): string {
  return renderToStaticMarkup(React.createElement(StatusIndicator, { status }))
}

function renderDotClassNames(status: Status): string[] {
  const markup = renderMarkup(status)
  const dotClassName = markup.match(/<span class="([^"]*rounded-full[^"]*)"/)?.[1]

  expect(dotClassName).toBeDefined()

  return dotClassName!.split(/\s+/)
}

describe('StatusIndicator setup state', () => {
  it('renders setup as a pulsing amber dot, not a working spinner', () => {
    const classNames = renderDotClassNames('setup')
    const markup = renderMarkup('setup')

    expect(classNames).toContain('bg-workspace-status-progress')
    expect(classNames).toContain('animate-pulse')
    // Why: a pulsing dot must still read as a static dot under reduced motion.
    expect(classNames).toContain('motion-reduce:animate-none')
    expect(classNames).not.toContain('bg-emerald-500')
    expect(markup).not.toContain('data-agent-spinner')
  })

  it('labels setup as its own state rather than an agent one', () => {
    const markup = renderMarkup('setup')

    expect(markup).toContain('data-state-indicator-tooltip="Setting up…"')
    expect(markup).not.toContain(' title=')
  })
})
