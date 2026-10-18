import { useEffect } from 'react'

import { restoreAgentTabFocusAfterGesture } from '@/lib/agent-tab-focus-policy'
import { hasVisibleOverlay, overlayLeftDom } from '@/lib/visible-overlay'

/** How long a closing interaction stays attributable to the overlay it closed. */
const CLOSE_INTENT_WINDOW_MS = 2_000

/**
 * Why: Enter or Space is how the keyboard opens or activates a menu item, dialog action
 * or field, so that path keeps the focus Radix returns to its trigger.
 */
type CloseIntent = 'pointer' | 'keyboard-activation' | 'dismiss'

/**
 * Hands keyboard focus back to the agent tab when an overlay closes.
 *
 * A menu, dialog or popover takes the caret while it is open and then gives it back to
 * whatever opened it — the sidebar button, the card menu's trigger, the panel row. That
 * is the same stranding a chrome click causes, only later, so the close is judged like
 * any other gesture: a pointer selection, a click outside, or Escape returns the caret to
 * the agent tab; Tab/Enter/Space navigation keeps its place.
 */
export function useAgentTabFocusOverlayClose(): void {
  useEffect(() => {
    if (typeof MutationObserver !== 'function' || typeof document === 'undefined') {
      return
    }
    let intent: { kind: CloseIntent; at: number } | null = null
    const note = (kind: CloseIntent): void => {
      // Why: only a gesture made while an overlay owns the caret can close one.
      if (hasVisibleOverlay()) {
        intent = { kind, at: Date.now() }
      }
    }
    const onPointerDown = (): void => note('pointer')
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        note('keyboard-activation')
      } else if (event.key === 'Escape') {
        note('dismiss')
      }
    }
    const observer = new MutationObserver((records) => {
      if (!records.some((record) => Array.from(record.removedNodes).some(overlayLeftDom))) {
        return
      }
      const armed = intent !== null && Date.now() - intent.at <= CLOSE_INTENT_WINDOW_MS
      if (!armed || intent?.kind === 'keyboard-activation') {
        return
      }
      // Why: the overlay runs its own close autofocus first (back to the trigger), so this
      // asks a frame later and wins only because the trigger is not a claim.
      restoreAgentTabFocusAfterGesture(1)
    })
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])
}
