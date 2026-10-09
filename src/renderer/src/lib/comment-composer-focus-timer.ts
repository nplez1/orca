export type CommentComposerFocusTimerRef = {
  current: ReturnType<typeof setTimeout> | null
}

export function clearCommentComposerFocusTimer(timerRef: CommentComposerFocusTimerRef): void {
  if (timerRef.current === null) {
    return
  }
  clearTimeout(timerRef.current)
  timerRef.current = null
}

/** Runs deferred focus/selection work for a comment composer, replacing any
 *  pending callback. Shared by every composer: a formatting button blurs the
 *  textarea, so the caret can only be restored after React re-renders the new
 *  value — and a composer can unmount before that work runs. */
export function scheduleCommentComposerFocusTimer(
  timerRef: CommentComposerFocusTimerRef,
  callback: () => void
): void {
  clearCommentComposerFocusTimer(timerRef)
  timerRef.current = setTimeout(() => {
    timerRef.current = null
    callback()
  }, 0)
}
