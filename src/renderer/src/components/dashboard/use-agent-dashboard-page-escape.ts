import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { hasVisibleOverlay } from '@/lib/visible-overlay'

function isEditableElement(target: EventTarget | null): target is HTMLElement {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

export function useAgentDashboardPageEscape(onClose: () => void): void {
  const activeModal = useAppStore((s) => s.activeModal)
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return
      }
      // A store modal owns Escape even before its lazy chunk paints and becomes visible.
      if (activeModal !== 'none') {
        return
      }
      // Menus, the terminal dialog and any other live layer own Escape while they are open.
      if (hasVisibleOverlay()) {
        return
      }
      const target = event.target
      // A terminal — including the floating workspace over this page — keeps Escape as its interrupt.
      if (target instanceof Element && target.closest('.xterm, [data-floating-terminal-panel]')) {
        return
      }
      // Esc first exits field focus, then closes the page, matching Tasks/Automations.
      if (isEditableElement(target)) {
        event.preventDefault()
        target.blur()
        return
      }
      event.preventDefault()
      onClose()
    }
    // Why: the app router runs ahead of Radix's document listener, which would otherwise consume Escape.
    addAppKeyListener('keydown', onKeyDown)
    return () => removeAppKeyListener('keydown', onKeyDown)
  }, [activeModal, onClose])
}
