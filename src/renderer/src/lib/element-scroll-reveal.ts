/**
 * Scrolling helpers for revealing an element inside whichever ancestor actually scrolls.
 *
 * The checks sidebar scrolls as one column, so `scrollIntoView` on a comment row moves the whole
 * workbench; these helpers find the real vertical scroll parent first. Honouring reduced motion
 * here, rather than at each call site, keeps a "take me there" jump from animating for users who
 * asked for no motion.
 */

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  )
}

export function resolveScrollBehavior(behavior: ScrollBehavior): ScrollBehavior {
  // Why: honour the user's reduced-motion preference by jumping instantly instead of animating a
  // smooth scroll (also makes the reveal deterministic in headless environments that never tick
  // the smooth-scroll animation).
  return behavior === 'smooth' && prefersReducedMotion() ? 'auto' : behavior
}

function findVerticalScrollParent(element: HTMLElement): HTMLElement | null {
  let parent = element.parentElement
  while (parent) {
    const style = window.getComputedStyle(parent)
    const canScroll = style.overflowY === 'auto' || style.overflowY === 'scroll'
    if (canScroll && parent.scrollHeight > parent.clientHeight) {
      return parent
    }
    parent = parent.parentElement
  }
  return null
}

/** Reveals an element with the least movement that makes it fully visible. */
export function scrollElementBottomIntoView(element: HTMLElement): void {
  const scrollParent = findVerticalScrollParent(element)
  if (!scrollParent) {
    element.scrollIntoView({ block: 'end', behavior: resolveScrollBehavior('smooth') })
    return
  }

  const padding = 8
  const parentRect = scrollParent.getBoundingClientRect()
  const elementRect = element.getBoundingClientRect()
  const bottomOverflow = elementRect.bottom - parentRect.bottom + padding
  if (bottomOverflow > 0) {
    scrollParent.scrollTo({
      top: scrollParent.scrollTop + bottomOverflow,
      behavior: resolveScrollBehavior('smooth')
    })
    return
  }

  const topOverflow = elementRect.top - parentRect.top - padding
  if (topOverflow < 0) {
    scrollParent.scrollTo({
      top: Math.max(0, scrollParent.scrollTop + topOverflow),
      behavior: resolveScrollBehavior('smooth')
    })
  }
}

/**
 * Centres an element in its scroll parent.
 *
 * Why centre rather than bottom-align: this is an explicit "take me there" jump, and a target
 * pinned to the viewport edge leaves no context above or below it.
 */
export function scrollElementCenterIntoView(element: HTMLElement): void {
  const scrollParent = findVerticalScrollParent(element)
  if (!scrollParent) {
    element.scrollIntoView({ block: 'center', behavior: resolveScrollBehavior('smooth') })
    return
  }

  const parentRect = scrollParent.getBoundingClientRect()
  const elementRect = element.getBoundingClientRect()
  const elementTop = elementRect.top - parentRect.top + scrollParent.scrollTop
  const elementCenter = elementTop + elementRect.height / 2
  scrollParent.scrollTo({
    top: Math.max(0, elementCenter - scrollParent.clientHeight / 2),
    behavior: resolveScrollBehavior('smooth')
  })
}
