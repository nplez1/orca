// The always-mounted worktree sidebar is page chrome, not an Escape-owning popup.
const OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="listbox"]:not([data-worktree-sidebar]), [role="menu"]'

/** True when a removed DOM node was, or contained, an overlay (a dialog, menu, listbox). */
export function overlayLeftDom(node: Node): boolean {
  return (
    typeof Element !== 'undefined' &&
    node instanceof Element &&
    (node.matches(OVERLAY_SELECTOR) || node.querySelector(OVERLAY_SELECTOR) !== null)
  )
}

type VisibleOverlayOptions = {
  /** Overlays inside a match are treated as page content, not as a layer above it. */
  ignoreSelector?: string
  /** Ignore matching chrome itself while retaining overlays nested within it. */
  ignoreMatches?: string
  /** A terminal hosted inside an overlay may still take focus within that overlay. */
  ignoreContaining?: Element
  /** An overlay animating out no longer outranks focus that was queued before it closed. */
  ignoreDismissed?: boolean
}

/** Live overlays own Escape before page handlers and outrank queued terminal focus. Ignore page chrome while retaining nested layers. */
export function hasVisibleOverlay(options?: VisibleOverlayOptions): boolean {
  return visibleOverlayElements(options).length > 0
}

/** The overlays actually on screen, for callers that need to name the ones a gesture saw. */
export function visibleOverlayElements(options?: VisibleOverlayOptions): Element[] {
  return Array.from(document.querySelectorAll(OVERLAY_SELECTOR)).filter((element) => {
    if (!(element instanceof HTMLElement)) {
      return false
    }
    if (element.closest('[aria-hidden="true"]')) {
      return false
    }
    if (options?.ignoreSelector && element.closest(options.ignoreSelector)) {
      return false
    }
    if (options?.ignoreMatches && element.matches(options.ignoreMatches)) {
      return false
    }
    if (options?.ignoreContaining && element.contains(options.ignoreContaining)) {
      return false
    }
    // Dismissed overlays remain painted during ~300ms exit animation; exclude them from focus ownership. Escape checks run before closed attributes update and must opt out.
    if (options?.ignoreDismissed && element.getAttribute('data-state') === 'closed') {
      return false
    }
    const style = window.getComputedStyle(element)
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      element.getClientRects().length > 0
    )
  })
}

// These don't own Escape, but still paint above pages: popper surfaces (tooltips, hover cards),
// toasts, modal backdrops and the floating workspace.
const OVERLAY_LAYER_SELECTOR = `${OVERLAY_SELECTOR}, [data-radix-popper-content-wrapper], [data-sonner-toast], [data-slot$="-overlay"], [data-floating-terminal-panel]`

/** Whether any overlay paints over `owner`'s `rect`; a native view there would hide it. Layers
 *  holding `owner`, like a floating workspace showing the page, are under it, not over it. */
export function hasVisibleOverlayOver(rect: DOMRectReadOnly, owner: Element): boolean {
  return Array.from(document.querySelectorAll(OVERLAY_LAYER_SELECTOR)).some((element) => {
    // Painted, not accessible: a modal's hideOthers() marks its own backdrop aria-hidden.
    if (
      element.contains(owner) ||
      !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    ) {
      return false
    }
    const box = element.getBoundingClientRect()
    return (
      box.width > 0 &&
      box.height > 0 &&
      box.left < rect.right &&
      box.right > rect.left &&
      box.top < rect.bottom &&
      box.bottom > rect.top
    )
  })
}
