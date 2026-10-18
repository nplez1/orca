// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { restoreAfterPanelBackgroundClick } = vi.hoisted(() => ({
  restoreAfterPanelBackgroundClick: vi.fn()
}))

vi.mock('@/lib/agent-tab-focus-policy', () => ({
  restoreAgentTabFocusAfterPanelBackgroundClick: restoreAfterPanelBackgroundClick
}))
// Why: the panels themselves are lazy-loaded real components; this file is about the
// panel body's own click wiring, so a stand-in panel keeps it to that.
vi.mock('@/lib/lazy-with-retry', () => ({
  lazyWithRetry: () => () => createElement('div', null, 'panel body')
}))

import { RightSidebarPanelContent } from './right-sidebar-panel-content'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  restoreAfterPanelBackgroundClick.mockReset()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
})

function mountPanel(): HTMLElement {
  act(() =>
    root.render(
      createElement(RightSidebarPanelContent, { effectiveTab: 'checks', rightSidebarOpen: true })
    )
  )
  const panel = container.firstElementChild
  if (!(panel instanceof HTMLElement)) {
    throw new Error('panel content did not render')
  }
  return panel
}

describe('right sidebar panel body click', () => {
  it('asks the focus policy after a pointer click on the panel', () => {
    const panel = mountPanel()

    act(() => {
      panel.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    })

    expect(restoreAfterPanelBackgroundClick).toHaveBeenCalledTimes(1)
  })

  it('passes the click through so the policy can tell a keyboard click apart', () => {
    const panel = mountPanel()

    act(() => {
      panel.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))
    })

    expect(restoreAfterPanelBackgroundClick).toHaveBeenCalledTimes(1)
    expect(restoreAfterPanelBackgroundClick.mock.calls[0][0]).toMatchObject({ detail: 0 })
  })
})
