/** Whether a review thread is drawn on its line or reduced to its gutter marker. */
export type PRCommentInlineDisplay = 'expanded' | 'collapsed'

/**
 * Decides how one thread is drawn.
 *
 * An explicit per-thread choice wins in both directions, so a user who expands a resolved thread
 * keeps it open, and a user who hides an open thread is not overruled by the next cache refresh.
 * With no explicit choice, a resolved thread starts collapsed — resolving is what the user meant by
 * "done with this" — and the global setting covers the rest.
 */
export function resolvePRCommentInlineDisplay(args: {
  override: PRCommentInlineDisplay | undefined
  /** The global "PR Comments Inline" setting. */
  enabled: boolean
  isResolved: boolean
}): PRCommentInlineDisplay {
  if (args.override) {
    return args.override
  }
  return args.enabled && !args.isResolved ? 'expanded' : 'collapsed'
}
