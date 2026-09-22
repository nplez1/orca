import type { Terminal } from '@xterm/xterm'
import { copyTerminalSelection } from '@/components/terminal-pane/terminal-selection-copy'
import { suppressTerminalRightClickPtyMouseReport } from '@/components/terminal-pane/terminal-right-click-pty-mouse-suppression'
import type { PreviewTerminalPasteSource } from './preview-terminal-paste'

type PreviewRightClickTerminal = Pick<
  Terminal,
  'element' | 'options' | 'getSelection' | 'clearSelection'
> & { modes: Pick<Terminal['modes'], 'mouseTrackingMode'> }

/**
 * Terminal-style right-click for the preview terminal, mirroring the pane's
 * useTerminalContextMenuTrigger: a selection copies and clears, no selection
 * pastes, and Ctrl+right-click keeps the native menu reachable.
 */
export function installPreviewTerminalRightClickPaste({
  container,
  getTerminal,
  isRightClickToPasteEnabled,
  pasteClipboardText
}: {
  container: HTMLElement
  getTerminal: () => PreviewRightClickTerminal | null
  isRightClickToPasteEnabled: () => boolean
  pasteClipboardText: (
    activeElementAtDispatch: Element | null,
    source: PreviewTerminalPasteSource
  ) => void
}): () => void {
  const onContextMenu = (event: MouseEvent): void => {
    const terminal = getTerminal()
    if (!terminal || !isRightClickToPasteEnabled() || event.ctrlKey) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (terminal.getSelection()) {
      void copyTerminalSelection({
        terminal,
        writeClipboardText: window.api.ui.writeTerminalClipboardText,
        clearSelectionOnSuccess: true
      }).catch(() => undefined)
      return
    }
    pasteClipboardText(document.activeElement, 'right-click')
  }
  const onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 2 || !isRightClickToPasteEnabled()) {
      return
    }
    const terminal = getTerminal()
    if (!terminal || terminal.modes.mouseTrackingMode === 'none') {
      return
    }
    suppressTerminalRightClickPtyMouseReport(terminal)
  }
  container.addEventListener('contextmenu', onContextMenu)
  container.addEventListener('mousedown', onMouseDown, { capture: true })
  return () => {
    container.removeEventListener('contextmenu', onContextMenu)
    container.removeEventListener('mousedown', onMouseDown, { capture: true })
  }
}
