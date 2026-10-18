import { useEffect } from 'react'

import { shouldPreserveEditableFocus } from '@/components/terminal-pane/pane-helpers'
import { restoreAgentTabFocusAfterGesture } from '@/lib/agent-tab-focus-policy'
import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'
import { overlayLeftDom, visibleOverlayElements } from '@/lib/visible-overlay'

/**
 * Why: a gesture is a claim only on the overlays that were on screen when it happened, so
 * the intent names them instead of a time window — a slow save may close its dialog
 * minutes later, and an unrelated overlay must not inherit the intent.
 */
type CloseIntent = {
  overlays: Element[]
  /** A dismissing click outside every overlay: focus that click lands on belongs to it. */
  pointerTarget: Element | null
}

function focusBelongsToClick(intent: CloseIntent): boolean {
  const target = intent.pointerTarget
  const active = document.activeElement
  if (target === null || active === null || active === document.body) {
    return false
  }
  // Why: the pointerdown target is the innermost element under the pointer, and Chromium
  // focuses a focusable ancestor (a panel row), so containment runs from the focused
  // element down to the target — not the other way.
  return active === target || active.contains(target)
}

/**
 * Hands keyboard focus back to the agent tab when an overlay closes.
 *
 * A menu, dialog or popover takes the caret while it is open and then gives it back to
 * whatever opened it — the sidebar button, the card menu's trigger, the panel row. That is
 * the same stranding a chrome click causes, only later, so the close is judged like any
 * other gesture: a pointer selection, a click outside, Escape, or Enter in a text field
 * returns the caret to the agent tab. Tab/Enter/Space navigation keeps its own focus, a
 * space typed into a field is just text, and a close with no gesture behind it is left
 * alone.
 */
export function useAgentTabFocusOverlayClose(): void {
  useEffect(() => {
    if (typeof MutationObserver !== 'function' || typeof document === 'undefined') {
      return
    }
    let intent: CloseIntent | null = null
    let observer: MutationObserver | null = null

    const disarm = (): void => {
      intent = null
      observer?.disconnect()
      observer = null
    }
    const settle = (current: CloseIntent): void => {
      // Why: Radix refocuses its trigger from a queued task as its content unmounts, and
      // the click that dismissed the overlay moves focus on mousedown — so decide after
      // both have run, then hand the caret over.
      setTimeout(() => {
        if (!focusBelongsToClick(current)) {
          restoreAgentTabFocusAfterGesture(1)
        }
      }, 0)
    }
    const arm = (next: CloseIntent): void => {
      intent = next
      if (observer !== null) {
        return
      }
      // Why: only armed gestures pay for watching removals, and only the overlays that were
      // on screen can be the one this gesture closes.
      observer = new MutationObserver((records) => {
        const current = intent
        if (current === null || !current.overlays.some((overlay) => !overlay.isConnected)) {
          return
        }
        if (records.some((record) => Array.from(record.removedNodes).some(overlayLeftDom))) {
          disarm()
          settle(current)
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })
    }

    const onPointerDown = (event: PointerEvent): void => {
      const overlays = visibleOverlayElements()
      if (overlays.length === 0) {
        disarm()
        return
      }
      const target = event.target instanceof Element ? event.target : null
      const insideOverlay = target !== null && overlays.some((overlay) => overlay.contains(target))
      arm({ overlays, pointerTarget: insideOverlay ? null : target })
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isImeOwnedKeyboardEvent(event)) {
        return
      }
      // Why: Tab is navigation — a caret that moved on since the gesture must not be pulled
      // back by an overlay closing later.
      if (event.key === 'Tab') {
        disarm()
        return
      }
      const overlays = visibleOverlayElements()
      if (overlays.length === 0) {
        disarm()
        return
      }
      const typingInField = shouldPreserveEditableFocus(
        event.target instanceof Element ? event.target : null
      )
      if (event.key === 'Escape') {
        arm({ overlays, pointerTarget: null })
        return
      }
      if (event.key !== 'Enter' && event.key !== ' ') {
        return
      }
      // Why: Enter in a text field submits or picks the highlighted row, which is a
      // selection like a click; a space typed into that field is just text.
      if (typingInField) {
        if (event.key === 'Enter') {
          arm({ overlays, pointerTarget: null })
        }
        return
      }
      // Why: Enter or Space on a control is the keyboard opening or activating what it
      // opened, so that path keeps the focus Radix returns to its trigger.
      disarm()
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      disarm()
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])
}
