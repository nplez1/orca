// @vitest-environment happy-dom
//
// A mouse-tracking TUI (Copilot CLI requests ?1003h/?1006h) reads the clipboard
// itself when a right-click reaches it, so Orca's own right-click paste landed on
// top of it. The pane must claim the gesture before xterm encodes the report.
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { useTerminalContextMenuTrigger } from './use-terminal-context-menu-trigger'

type TestTerminal = {
  element: HTMLDivElement
  modes: { mouseTrackingMode: 'none' | 'any' }
  options: { mouseEventsRequireAlt: boolean }
}

function buildPane(mouseTrackingMode: 'none' | 'any'): {
  pane: ManagedPane
  terminal: TestTerminal
} {
  const container = document.createElement('div')
  const terminal: TestTerminal = {
    element: document.createElement('div'),
    modes: { mouseTrackingMode },
    options: { mouseEventsRequireAlt: false }
  }
  container.appendChild(terminal.element)
  document.body.appendChild(container)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only stub; the hook only reads id/container/terminal off ManagedPane.
  const pane = { id: 1, container, terminal } as unknown as ManagedPane
  return { pane, terminal }
}

function renderTrigger(pane: ManagedPane, rightClickToPaste: boolean) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only stub; the hook only reads getPanes off PaneManager.
  const manager = { getPanes: () => [pane] } as unknown as PaneManager
  return renderHook(() =>
    useTerminalContextMenuTrigger({
      managerRef: { current: manager },
      containerRef: { current: null },
      contextPaneIdRef: { current: null },
      rightClickToPaste,
      pasteResolvedPane: vi.fn(async () => undefined)
    })
  )
}

function mouseDown(
  handler: (event: React.MouseEvent<HTMLDivElement>) => void,
  target: EventTarget,
  button: number
): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only stub; the handler only reads button/target.
  handler({ button, target } as unknown as React.MouseEvent<HTMLDivElement>)
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('useTerminalContextMenuTrigger right-click ownership', () => {
  it('withholds a right-click from a mouse-tracking pane', () => {
    const { pane, terminal } = buildPane('any')
    const { result } = renderTrigger(pane, true)

    mouseDown(result.current.onMouseDownCapture, terminal.element, 2)

    expect(terminal.options.mouseEventsRequireAlt).toBe(true)
  })

  it('leaves a pane that did not request mouse tracking alone', () => {
    const { pane, terminal } = buildPane('none')
    const { result } = renderTrigger(pane, true)

    mouseDown(result.current.onMouseDownCapture, terminal.element, 2)

    expect(terminal.options.mouseEventsRequireAlt).toBe(false)
  })

  it('leaves the click to the app when paste-on-right-click is off', () => {
    const { pane, terminal } = buildPane('any')
    const { result } = renderTrigger(pane, false)

    mouseDown(result.current.onMouseDownCapture, terminal.element, 2)

    expect(terminal.options.mouseEventsRequireAlt).toBe(false)
  })

  it('ignores other buttons', () => {
    const { pane, terminal } = buildPane('any')
    const { result } = renderTrigger(pane, true)

    mouseDown(result.current.onMouseDownCapture, terminal.element, 1)

    expect(terminal.options.mouseEventsRequireAlt).toBe(false)
  })

  it('ignores a right-click outside every pane', () => {
    const { pane, terminal } = buildPane('any')
    const { result } = renderTrigger(pane, true)
    const outside = document.createElement('div')
    document.body.appendChild(outside)

    mouseDown(result.current.onMouseDownCapture, outside, 2)

    expect(terminal.options.mouseEventsRequireAlt).toBe(false)
  })
})
