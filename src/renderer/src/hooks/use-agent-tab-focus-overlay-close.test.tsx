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
  const item = document.createElement('button')
  item.textContent = 'Copy Path'
  overlay.append(item)
  document.body.append(overlay)
  return overlay
}

function pointerDownOn(target: EventTarget): void {
  target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
}

function keyDownOn(target: EventTarget, key: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
}

/** Remove the overlay and let the observer's microtask and the queued check settle. */
async function closeOverlay(overlay: HTMLElement): Promise<void> {
  await act(async () => {
    overlay.remove()
    await drainQueuedTasks()
  })
}

/**
 * Why: the hook decides from its own queued 0ms task, which the removal's observer
 * microtask only schedules after the first tick — one tick left the decision pending
 * past the assertion, so the test raced the code it was testing.
 */
async function drainQueuedTasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
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

afterEach(async () => {
  // Why: the hook decides from a queued task; let it run inside this test so it cannot
  // land after the next test has reset the spy.
  await act(async () => {
    await drainQueuedTasks()
  })
  act(() => root.unmount())
  document.body.replaceChildren()
})

describe('overlay close returns focus to the agent tab', () => {
  it('restores after a pointer selection closes the menu', async () => {
    const overlay = mountOverlay()
    const item = overlay.querySelector('button')
    pointerDownOn(item ?? overlay)

    await closeOverlay(overlay)

    expect(restore).toHaveBeenCalled()
  })

  it('restores after a click outside closes a popup whose input had the caret', async () => {
    const overlay = mountOverlay()
    const input = document.createElement('input')
    overlay.append(input)
    input.focus()
    const outside = document.createElement('div')
    document.body.append(outside)
    pointerDownOn(outside)

    await closeOverlay(overlay)

    // The input that had the caret is gone, so nothing legitimate owns focus.
    expect(restore).toHaveBeenCalled()
  })

  it('leaves the focus a dismissing click landed on', async () => {
    const overlay = mountOverlay()
    const row = document.createElement('button')
    const label = document.createElement('span')
    row.append(label)
    document.body.append(row)
    // A real click lands on the innermost element and Chromium focuses the row.
    pointerDownOn(label)
    row.focus()

    await closeOverlay(overlay)

    // A panel row takes its own keyboard focus; the page-focus rule keeps it there.
    expect(restore).not.toHaveBeenCalled()
  })

  it('leaves focus that lands after the overlay is gone', async () => {
    const overlay = mountOverlay()
    const row = document.createElement('button')
    document.body.append(row)
    pointerDownOn(row)
    // A synchronously closed popup unmounts before mousedown moves the focus: the removal
    // is observed first, and only then does the click land on the row.
    overlay.remove()
    await act(async () => {
      await Promise.resolve()
    })
    row.focus()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(restore).not.toHaveBeenCalled()
  })

  it('restores after Escape dismisses the dialog', async () => {
    const overlay = mountOverlay('dialog')
    keyDownOn(document, 'Escape')

    await closeOverlay(overlay)

    expect(restore).toHaveBeenCalled()
  })

  it('restores when Enter in the popup text field picks a row', async () => {
    const overlay = mountOverlay('dialog')
    const input = document.createElement('input')
    overlay.append(input)
    input.focus()
    keyDownOn(input, 'Enter')

    await closeOverlay(overlay)

    expect(restore).toHaveBeenCalled()
  })

  it('treats a space typed into the popup field as text', async () => {
    const overlay = mountOverlay('dialog')
    const input = document.createElement('input')
    overlay.append(input)
    input.focus()
    keyDownOn(input, ' ')

    await closeOverlay(overlay)

    expect(restore).not.toHaveBeenCalled()
  })

  it('leaves Enter on a control its own focus', async () => {
    const overlay = mountOverlay()
    const item = overlay.querySelector('button')
    keyDownOn(item ?? overlay, 'Enter')

    await closeOverlay(overlay)

    expect(restore).not.toHaveBeenCalled()
  })

  it('leaves Space on a control its own focus, even after an earlier gesture', async () => {
    const overlay = mountOverlay()
    const item = overlay.querySelector('button')
    pointerDownOn(overlay)
    keyDownOn(item ?? overlay, ' ')

    await closeOverlay(overlay)

    expect(restore).not.toHaveBeenCalled()
  })

  it('leaves Tab navigation alone', async () => {
    const overlay = mountOverlay()
    pointerDownOn(overlay)
    // The caret moved on with the keyboard, so an overlay leaving later must not pull it.
    keyDownOn(document, 'Tab')

    await closeOverlay(overlay)

    expect(restore).not.toHaveBeenCalled()
  })

  it('treats Enter as navigation even after a pointer opened the menu', async () => {
    const overlay = mountOverlay()
    const item = overlay.querySelector('button')
    pointerDownOn(item ?? overlay)
    keyDownOn(item ?? overlay, 'Enter')

    await closeOverlay(overlay)

    expect(restore).not.toHaveBeenCalled()
  })

  it('ignores an Enter the IME owns', async () => {
    const overlay = mountOverlay('dialog')
    const input = document.createElement('input')
    overlay.append(input)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }))

    await closeOverlay(overlay)

    expect(restore).not.toHaveBeenCalled()
  })

  it('ignores a removal with no gesture behind it', async () => {
    const overlay = mountOverlay()

    await closeOverlay(overlay)

    expect(restore).not.toHaveBeenCalled()
  })

  it('ignores an overlay the gesture never saw', async () => {
    const first = mountOverlay()
    pointerDownOn(first.querySelector('button') ?? first)
    // A second overlay opens after the gesture: its close is not this intent's.
    const second = mountOverlay('dialog')

    await closeOverlay(second)

    expect(restore).not.toHaveBeenCalled()

    // The overlay the gesture did see still restores when it closes.
    await closeOverlay(first)
    expect(restore).toHaveBeenCalled()
  })

  it('ignores a removal that was not an overlay', async () => {
    mountOverlay()
    const card = document.createElement('div')
    card.className = 'workspace-card'
    document.body.append(card)
    pointerDownOn(card)

    await closeOverlay(card)

    expect(restore).not.toHaveBeenCalled()
  })
})
