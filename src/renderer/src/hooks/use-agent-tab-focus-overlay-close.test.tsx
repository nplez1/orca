// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { restore } = vi.hoisted(() => ({ restore: vi.fn() }))

vi.mock('@/lib/agent-tab-focus-policy', () => ({
  restoreAgentTabFocusAfterGesture: restore
}))

import { useAgentTabFocusOverlayClose } from './use-agent-tab-focus-overlay-close'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function Probe(): null {
  useAgentTabFocusOverlayClose()
  return null
}

function mountOverlay(role = 'menu'): HTMLElement {
  const overlay = document.createElement('div')
  overlay.setAttribute('role', role)
  document.body.append(overlay)
  return overlay
}

function pointerDownInside(): void {
  document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
}

function keyDown(key: string): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
}

/** Remove the overlay and let the observer's microtask (and any effect work) settle. */
async function closeOverlay(overlay: HTMLElement): Promise<void> {
  await act(async () => {
    overlay.remove()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  restore.mockReset()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(createElement(Probe)))
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
})

describe('overlay close returns focus to the agent tab', () => {
  it('restores after a pointer selection closes the menu', async () => {
    const overlay = mountOverlay()
    pointerDownInside()

    await closeOverlay(overlay)

    expect(restore).toHaveBeenCalledTimes(1)
  })

  it('restores after a click outside closes the menu', async () => {
    const overlay = mountOverlay()
    overlay.append(document.createElement('input'))
    pointerDownInside()

    await closeOverlay(overlay)

    // Why: the input that had the caret is gone, so nothing legitimate owns focus.
    expect(restore).toHaveBeenCalledTimes(1)
  })

  it('restores after Escape dismisses the dialog', async () => {
    const overlay = mountOverlay('dialog')
    keyDown('Escape')

    await closeOverlay(overlay)

    expect(restore).toHaveBeenCalledTimes(1)
  })

  it('leaves Enter navigation its own focus', async () => {
    const overlay = mountOverlay()
    keyDown('Enter')

    await closeOverlay(overlay)

    expect(restore).not.toHaveBeenCalled()
  })

  it('leaves Space navigation its own focus', async () => {
    const overlay = mountOverlay()
    keyDown(' ')

    await closeOverlay(overlay)

    expect(restore).not.toHaveBeenCalled()
  })

  it('treats Enter as navigation even after a pointer opened the menu', async () => {
    const overlay = mountOverlay()
    pointerDownInside()
    keyDown('Enter')

    await closeOverlay(overlay)

    expect(restore).not.toHaveBeenCalled()
  })

  it('ignores a removal with no gesture behind it', async () => {
    const overlay = mountOverlay()

    await closeOverlay(overlay)

    expect(restore).not.toHaveBeenCalled()
  })

  it('ignores a removal that was not an overlay', async () => {
    const card = document.createElement('div')
    card.className = 'workspace-card'
    document.body.append(card)
    pointerDownInside()

    await closeOverlay(card)

    expect(restore).not.toHaveBeenCalled()
  })
})
