import type { Terminal } from '@xterm/xterm'

/** Only the members the claim touches, so callers can pass a narrow terminal view. */
type RightClickPtyMouseTerminal = {
  element?: HTMLElement | undefined
  options: Pick<Terminal['options'], 'mouseEventsRequireAlt'>
}

// Why: a second mousedown before the first mouseup must not save `true` as the
// previous value, which would strand mouseEventsRequireAlt on for the pane.
const pendingRestores = new WeakMap<object, () => void>()

/**
 * Why: with paste-on-right-click on, Orca owns the right-click — but xterm still
 * reports it to a mouse-tracking child app, and Copilot CLI reads the clipboard
 * itself on a forwarded right-click, so one click pastes twice. Requiring Alt
 * withholds the whole gesture (press, drag, release) from the app, and holding
 * Alt still passes it through for anyone who wants the app to see the click.
 */
export function suppressTerminalRightClickPtyMouseReport(
  terminal: RightClickPtyMouseTerminal
): void {
  if (pendingRestores.has(terminal)) {
    return
  }
  const ownerDocument = terminal.element?.ownerDocument
  const ownerWindow = ownerDocument?.defaultView
  if (!ownerDocument || !ownerWindow) {
    return
  }
  const previousMouseEventsRequireAlt = Boolean(terminal.options.mouseEventsRequireAlt)
  const restore = (): void => {
    ownerDocument.removeEventListener('mouseup', restore)
    ownerWindow.removeEventListener('blur', restore)
    pendingRestores.delete(terminal)
    terminal.options.mouseEventsRequireAlt = previousMouseEventsRequireAlt
  }
  pendingRestores.set(terminal, restore)
  terminal.options.mouseEventsRequireAlt = true
  // Why: the release must stay suppressed too, and bubble phase is what keeps
  // this restore after xterm's own mouseup handler.
  ownerDocument.addEventListener('mouseup', restore)
  ownerWindow.addEventListener('blur', restore)
}
