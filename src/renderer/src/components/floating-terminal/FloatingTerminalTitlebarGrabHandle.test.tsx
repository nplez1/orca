// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { FloatingTerminalTitlebarGrabHandle } from './FloatingTerminalTitlebarGrabHandle'
import { isFloatingTerminalDragTarget } from './floating-terminal-panel-drag-target'

afterEach(cleanup)

function renderHandle(): { handle: Element; icon: Element } {
  const { container } = render(<FloatingTerminalTitlebarGrabHandle />)
  const handle = container.querySelector('[data-floating-terminal-drag-handle]')
  if (!handle) {
    throw new Error('grab handle not rendered')
  }
  const icon = handle.querySelector('svg')
  if (!icon) {
    throw new Error('grip icon not rendered')
  }
  return { handle, icon }
}

describe('FloatingTerminalTitlebarGrabHandle', () => {
  it('stays a plain div that the panel drag handler treats as a move target', () => {
    const { handle } = renderHandle()
    expect(handle.tagName).toBe('DIV')
    expect(handle.hasAttribute('data-floating-terminal-no-drag')).toBe(false)
    expect(isFloatingTerminalDragTarget(handle)).toBe(true)
  })

  it('still starts a panel drag when the press lands on the grip icon', () => {
    const { icon } = renderHandle()
    expect(isFloatingTerminalDragTarget(icon)).toBe(true)
  })

  it('advertises the grab affordance', () => {
    const { handle } = renderHandle()
    expect(handle.className).toContain('cursor-grab')
  })
})
