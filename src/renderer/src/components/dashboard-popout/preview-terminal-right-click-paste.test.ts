// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installPreviewTerminalRightClickPaste } from './preview-terminal-right-click-paste'

describe('installPreviewTerminalRightClickPaste', () => {
  const writeTerminalClipboardText = vi.fn(async () => {})
  const pasteClipboardText = vi.fn()
  let container: HTMLElement
  let selection: string
  let clearSelection: ReturnType<typeof vi.fn<() => void>>
  let rightClickToPaste: boolean
  let mouseTrackingMode: 'none' | 'any'
  let terminalOptions: { mouseEventsRequireAlt: boolean }

  const install = (): (() => void) =>
    installPreviewTerminalRightClickPaste({
      container,
      getTerminal: () => ({
        getSelection: () => selection,
        clearSelection,
        element: container,
        modes: { mouseTrackingMode },
        options: terminalOptions
      }),
      isRightClickToPasteEnabled: () => rightClickToPaste,
      pasteClipboardText
    })

  const rightClick = (init: MouseEventInit = {}): MouseEvent => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ...init })
    container.dispatchEvent(event)
    return event
  }

  const mouseDown = (init: MouseEventInit = {}): void => {
    container.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, ...init })
    )
  }

  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
    container = document.createElement('div')
    document.body.appendChild(container)
    selection = ''
    clearSelection = vi.fn<() => void>()
    rightClickToPaste = true
    mouseTrackingMode = 'any'
    terminalOptions = { mouseEventsRequireAlt: false }
    Object.assign(window, { api: { ui: { writeTerminalClipboardText } } })
  })

  it('pastes when nothing is selected', () => {
    install()
    const event = rightClick()
    expect(event.defaultPrevented).toBe(true)
    expect(pasteClipboardText).toHaveBeenCalledWith(document.activeElement, 'right-click')
    expect(writeTerminalClipboardText).not.toHaveBeenCalled()
  })

  it('copies and clears the selection instead of pasting', async () => {
    selection = 'selected text'
    install()
    const event = rightClick()
    expect(event.defaultPrevented).toBe(true)
    expect(writeTerminalClipboardText).toHaveBeenCalledWith('selected text')
    await vi.waitFor(() => expect(clearSelection).toHaveBeenCalledOnce())
    expect(pasteClipboardText).not.toHaveBeenCalled()
  })

  it('keeps the selection when the clipboard write fails', async () => {
    selection = 'selected text'
    writeTerminalClipboardText.mockRejectedValueOnce(new Error('denied'))
    install()
    rightClick()
    await Promise.resolve()
    expect(clearSelection).not.toHaveBeenCalled()
  })

  it('falls through to the native menu on Ctrl+right-click', () => {
    install()
    const event = rightClick({ ctrlKey: true })
    expect(event.defaultPrevented).toBe(false)
    expect(pasteClipboardText).not.toHaveBeenCalled()
  })

  it('falls through to the native menu when the setting is off', () => {
    rightClickToPaste = false
    install()
    const event = rightClick()
    expect(event.defaultPrevented).toBe(false)
    expect(pasteClipboardText).not.toHaveBeenCalled()
  })

  it('falls through before the terminal exists and stops listening once disposed', () => {
    const dispose = installPreviewTerminalRightClickPaste({
      container,
      getTerminal: () => null,
      isRightClickToPasteEnabled: () => true,
      pasteClipboardText
    })
    expect(rightClick().defaultPrevented).toBe(false)
    dispose()

    const disposeSecond = install()
    disposeSecond()
    mouseDown({ button: 2 })
    expect(terminalOptions.mouseEventsRequireAlt).toBe(false)
    expect(rightClick().defaultPrevented).toBe(false)
    expect(pasteClipboardText).not.toHaveBeenCalled()
  })

  it('keeps a right-click from also reaching a mouse-tracking app', () => {
    install()

    mouseDown({ button: 2 })

    expect(terminalOptions.mouseEventsRequireAlt).toBe(true)
  })

  it('leaves the right-click to the app when the setting is off or the app ignores the mouse', () => {
    install()
    rightClickToPaste = false
    mouseDown({ button: 2 })
    expect(terminalOptions.mouseEventsRequireAlt).toBe(false)

    rightClickToPaste = true
    mouseTrackingMode = 'none'
    mouseDown({ button: 2 })
    mouseDown({ button: 1 })
    expect(terminalOptions.mouseEventsRequireAlt).toBe(false)
  })
})
