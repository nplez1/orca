import { useLayoutEffect, useRef, type MutableRefObject, type RefObject } from 'react'

type CommentCardResize = {
  /** Attach to the outer card element whose rendered height the view zone must track. */
  cardRef: RefObject<HTMLDivElement | null>
  /** Always-current resize callback, so effects can depend on nothing but the observer flag. */
  onContentResizeRef: MutableRefObject<(() => void) | undefined>
}

/**
 * Keeps a Monaco view zone's fixed `heightInPx` in step with the card it holds.
 *
 * Monaco never re-measures a zone, so a card that grows past its insertion estimate overlaps the
 * lines below it. The observer re-reports the real height; `onContentResize` is the decorator's
 * `resizeDiffCommentZone`, which re-layouts the zone in place.
 *
 * The callback is read through a ref: callers pass a fresh arrow every render, and depending on it
 * would re-create the observer on each one.
 */
export function useCommentCardResize(
  observeRenderedSize: boolean,
  onContentResize: (() => void) | undefined
): CommentCardResize {
  const cardRef = useRef<HTMLDivElement | null>(null)
  const onContentResizeRef = useRef(onContentResize)
  onContentResizeRef.current = onContentResize
  const observesRenderedSize = observeRenderedSize && onContentResize !== undefined

  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card || !observesRenderedSize) {
      return
    }
    onContentResizeRef.current?.()
    let frameId: number | null = null
    const notifyResize = (): void => {
      if (frameId !== null) {
        return
      }
      frameId = requestAnimationFrame(() => {
        frameId = null
        onContentResizeRef.current?.()
      })
    }
    if (typeof ResizeObserver === 'undefined') {
      return () => {
        if (frameId !== null) {
          cancelAnimationFrame(frameId)
        }
      }
    }
    // Why: narrow diff panes can wrap body/header text after Monaco's initial estimate.
    const observer = new ResizeObserver(() => notifyResize())
    observer.observe(card)
    return () => {
      observer.disconnect()
      if (frameId !== null) {
        cancelAnimationFrame(frameId)
      }
    }
  }, [observesRenderedSize])

  return { cardRef, onContentResizeRef }
}
