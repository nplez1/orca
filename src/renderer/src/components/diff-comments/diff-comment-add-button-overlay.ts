import * as monaco from 'monaco-editor'
import type { editor as monacoEditor } from 'monaco-editor'
import { useEffect, useRef, type RefObject } from 'react'
import { getDiffCommentPopoverTop } from './diff-comment-popover-position'
import type { DiffCommentLineRange } from './diff-comment-line-range'
import { toDiffCommentLineTarget } from './diff-comment-line-range'
import {
  getGutterPressLine,
  installDiffCommentRangeDrag,
  type DiffCommentRangeDragHandle
} from './diff-comment-range-drag'

// Monaco glyph decorations don't expose usable click events, so we own an absolutely-positioned "+" button that follows the hovered line.

type AddButtonOverlayArgs = {
  editor: monacoEditor.ICodeEditor
  editorDomNode: HTMLElement
  addButtonLabel: string
  commentableLineSet: Set<number> | null
  /**
   * Lines whose gutter slot already carries another affordance — a collapsed review thread's
   * bubble. The "+" stands down there: two controls sharing one slot leaves a click with two
   * possible meanings, and the conversation is the one the reader came for. The Add Review Note
   * chord still reaches these lines, so the capability is displaced rather than dropped.
   */
  gutterOccupiedLines: ReadonlySet<number>
  // The hovered line survives model-swap rebuilds so a press on the parked button still has an anchor.
  hoverLineRef: RefObject<number | null>
  onAddCommentClickRef: RefObject<
    (args: { lineNumber: number; startLine?: number; top: number }) => void
  >
}

export type DiffCommentAddButtonOverlayHandle = {
  dispose: () => void
  setPendingRange: DiffCommentRangeDragHandle['setPendingRange']
  isDragging: DiffCommentRangeDragHandle['isDragging']
  /**
   * Hands the running overlay a new set of lines another control owns, instead of reinstalling it.
   *
   * Why: the set is derived from the review thread list, so it changes whenever any thread anywhere
   * is expanded or collapsed and whenever PR comments are refetched. Reinstalling would drop a
   * gutter drag in flight and re-park the button, so the overlay is told and re-checks the hover.
   */
  setGutterOccupiedLines: (lines: ReadonlySet<number>) => void
}

/**
 * Keeps the "+" overlay installed for as long as the editor lives here.
 *
 * Its own module because the overlay owns its install/teardown: a commentable-line change rebuilds
 * the button and the range-drag controller it parks on, and a model swap rebuilds it hidden on the
 * new model. The occupied-line set is pushed in through the handle instead, so churn in the review
 * thread list never tears the overlay down.
 */
export function useDiffCommentAddButtonOverlay({
  editor,
  monacoModelIdentity,
  addButtonLabel,
  commentableLineSet,
  gutterOccupiedLines,
  hoverLineRef,
  onAddCommentClickRef,
  pendingRangeRef,
  overlayRef
}: {
  editor: monacoEditor.ICodeEditor | null
  /** Not read here — a model swap rebuilds the overlay so no hover line survives onto the new model. */
  monacoModelIdentity?: string
  addButtonLabel: string
  commentableLineSet: Set<number> | null
  gutterOccupiedLines: ReadonlySet<number>
  hoverLineRef: RefObject<number | null>
  onAddCommentClickRef: RefObject<
    (args: { lineNumber: number; startLine?: number; top: number }) => void
  >
  /** Read at install time, never a dependency: an open composer must not reinstall the overlay. */
  pendingRangeRef: RefObject<DiffCommentLineRange | null>
  overlayRef: RefObject<DiffCommentAddButtonOverlayHandle | null>
}): void {
  // Why a ref rather than a dependency: the set changes identity on every review refresh and every
  // thread toggle anywhere, and reinstalling for that would drop a gutter drag in flight.
  const occupiedLinesRef = useRef(gutterOccupiedLines)
  useEffect(() => {
    occupiedLinesRef.current = gutterOccupiedLines
    overlayRef.current?.setGutterOccupiedLines(gutterOccupiedLines)
  }, [gutterOccupiedLines, overlayRef])

  useEffect(() => {
    if (!editor) {
      return
    }
    const editorDomNode = editor.getDomNode()
    if (!editorDomNode) {
      return
    }
    const overlay = installDiffCommentAddButtonOverlay({
      editor,
      editorDomNode,
      addButtonLabel,
      commentableLineSet,
      gutterOccupiedLines: occupiedLinesRef.current,
      hoverLineRef,
      onAddCommentClickRef
    })
    overlayRef.current = overlay
    overlay.setPendingRange(pendingRangeRef.current)
    return () => {
      overlayRef.current = null
      overlay.dispose()
    }
  }, [
    addButtonLabel,
    commentableLineSet,
    editor,
    hoverLineRef,
    monacoModelIdentity,
    onAddCommentClickRef,
    overlayRef,
    pendingRangeRef
  ])
}

export function installDiffCommentAddButtonOverlay({
  editor,
  editorDomNode,
  addButtonLabel,
  commentableLineSet,
  gutterOccupiedLines,
  hoverLineRef,
  onAddCommentClickRef
}: AddButtonOverlayArgs): DiffCommentAddButtonOverlayHandle {
  const plus = document.createElement('button')
  plus.type = 'button'
  plus.className = 'orca-diff-comment-add-btn'
  plus.title = addButtonLabel
  plus.setAttribute('aria-label', addButtonLabel)
  plus.innerHTML =
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>'
  plus.style.display = 'none'
  editorDomNode.appendChild(plus)

  const getLineHeight = (): number => {
    const h = editor.getOption(monaco.editor.EditorOption.lineHeight)
    return typeof h === 'number' && h > 0 ? h : 19
  }

  // Cache last-applied styles so positionAtLine skips redundant DOM writes on high-freq mousemove (restyling under the cursor flickers).
  let lastTop: number | null = null
  let lastDisplay: string | null = null
  let dragging = false

  const setDisplay = (value: string): void => {
    if (lastDisplay === value) {
      return
    }
    plus.style.display = value
    lastDisplay = value
  }

  // Fixed 18px square centered in the line box — tracking line-height made a rectangle on taller line-heights.
  const BUTTON_SIZE = 18

  // Mutable so a thread expanding or collapsing never rebuilds the overlay; see `setGutterOccupiedLines`.
  let occupiedLines = gutterOccupiedLines

  const canCommentOnLine = (lineNumber: number): boolean => {
    if (occupiedLines.has(lineNumber)) {
      return false
    }
    return commentableLineSet === null || commentableLineSet.has(lineNumber)
  }

  const positionAtLine = (lineNumber: number): void => {
    const lineTop = editor.getTopForLineNumber(lineNumber) - editor.getScrollTop()
    const top = Math.round(lineTop + (getLineHeight() - BUTTON_SIZE) / 2)
    if (top !== lastTop) {
      plus.style.top = `${top}px`
      lastTop = top
    }
    setDisplay('flex')
  }

  const rangeDrag = installDiffCommentRangeDrag({
    editor,
    editorDomNode,
    commentableLineSet,
    // A press on the "+" itself has no Monaco gutter target, so it resolves through the line the
    // button is parked on.
    resolvePressLine: (event) =>
      event.target instanceof Node && plus.contains(event.target)
        ? hoverLineRef.current
        : getGutterPressLine(editor, event),
    onDragChange: ({ dragging: isDragging, focusLine }) => {
      dragging = isDragging
      // Why: inert while dragging so it can't punch a hit-test hole in the band the pointer is
      // sweeping — but it still rides the growing end of the selection, which is the only thing
      // telling the user the drag is live.
      plus.style.pointerEvents = isDragging ? 'none' : ''
      editorDomNode.classList.toggle('orca-diff-comment-range-dragging', isDragging)
      if (isDragging && focusLine !== null) {
        hoverLineRef.current = focusLine
        positionAtLine(focusLine)
      }
    },
    onCommit: (range) => {
      const top = getDiffCommentPopoverTop(editor, range.endLine, getLineHeight())
      if (top == null) {
        return
      }
      onAddCommentClickRef.current({ ...toDiffCommentLineTarget(range), top })
    }
  })

  const onMouseMove = editor.onMouseMove((e) => {
    if (dragging) {
      return
    }
    // Monaco reports null position over our "+" button; hiding on null would flicker-loop, so keep it visible while the cursor's on it.
    const srcEvent = e.event?.browserEvent as MouseEvent | undefined
    if (srcEvent && plus.contains(srcEvent.target as Node)) {
      return
    }
    const ln = e.target.position?.lineNumber ?? null
    if (ln == null || !canCommentOnLine(ln)) {
      hoverLineRef.current = null
      setDisplay('none')
      return
    }
    hoverLineRef.current = ln
    positionAtLine(ln)
  })
  // Keep hoverLineRef on mouse-leave: Monaco's content-area leave fires before the button's, so a click in that gap still resolves to the last-hovered line.
  const onMouseLeave = editor.onMouseLeave(() => {
    if (!dragging) {
      setDisplay('none')
    }
  })
  const onScroll = editor.onDidScrollChange(() => {
    if (dragging) {
      return
    }
    const parked = hoverLineRef.current
    if (parked == null) {
      return
    }
    // Why hide rather than skip: the parked line can stop being ours (its thread collapsed, or the
    // commentable set narrowed). Leaving the button at its old pixels would park a "+" for a line it
    // no longer belongs to, and a press on it would target that stale line.
    if (!canCommentOnLine(parked)) {
      hoverLineRef.current = null
      setDisplay('none')
      return
    }
    positionAtLine(parked)
  })

  const disposables = [onMouseMove, onMouseLeave, onScroll]

  return {
    dispose: () => {
      for (const d of disposables) {
        d.dispose()
      }
      rangeDrag.dispose()
      editorDomNode.classList.remove('orca-diff-comment-range-dragging')
      plus.remove()
    },
    setPendingRange: rangeDrag.setPendingRange,
    isDragging: rangeDrag.isDragging,
    setGutterOccupiedLines: (lines) => {
      occupiedLines = lines
      // A thread collapsed under a stationary pointer: the "+" must go rather than sit on the bubble
      // until the next mousemove. Not while dragging: there the "+" is what shows the gesture is live.
      const parked = hoverLineRef.current
      if (dragging || parked == null || canCommentOnLine(parked)) {
        return
      }
      hoverLineRef.current = null
      setDisplay('none')
    }
  }
}
