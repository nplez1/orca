// @vitest-environment happy-dom
//
// With paste-on-right-click enabled Orca owns the right-click, but xterm still
// reports it to a mouse-tracking child app. Copilot CLI reads the clipboard
// itself on a forwarded right-click, so one click pasted the clipboard twice.
import { afterEach, describe, expect, it } from 'vitest'
import { suppressTerminalRightClickPtyMouseReport } from './terminal-right-click-pty-mouse-suppression'

function buildTerminal(
  options: { mouseEventsRequireAlt: boolean } = { mouseEventsRequireAlt: false }
): {
  element: HTMLDivElement
  options: { mouseEventsRequireAlt: boolean }
} {
  const element = document.createElement('div')
  document.body.appendChild(element)
  return { element, options }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('suppressTerminalRightClickPtyMouseReport', () => {
  it('withholds the gesture from the pty until the mouse is released', () => {
    const terminal = buildTerminal()
    const requireAltDuringElementMouseUp: boolean[] = []
    terminal.element.addEventListener('mouseup', () => {
      requireAltDuringElementMouseUp.push(terminal.options.mouseEventsRequireAlt)
    })

    suppressTerminalRightClickPtyMouseReport(terminal)
    expect(terminal.options.mouseEventsRequireAlt).toBe(true)

    terminal.element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))

    // Why: restoring in the capture phase would leak the release report to the app.
    expect(requireAltDuringElementMouseUp).toEqual([true])
    expect(terminal.options.mouseEventsRequireAlt).toBe(false)
  })

  it('restores the value the pane already had', () => {
    const terminal = buildTerminal({ mouseEventsRequireAlt: true })

    suppressTerminalRightClickPtyMouseReport(terminal)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))

    expect(terminal.options.mouseEventsRequireAlt).toBe(true)
  })

  it('restores when the window loses focus mid-gesture', () => {
    const terminal = buildTerminal()

    suppressTerminalRightClickPtyMouseReport(terminal)
    window.dispatchEvent(new Event('blur'))

    expect(terminal.options.mouseEventsRequireAlt).toBe(false)
  })

  it('keeps the saved value across a repeated mousedown with no mouseup', () => {
    const terminal = buildTerminal()

    suppressTerminalRightClickPtyMouseReport(terminal)
    suppressTerminalRightClickPtyMouseReport(terminal)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))

    expect(terminal.options.mouseEventsRequireAlt).toBe(false)
  })
})
