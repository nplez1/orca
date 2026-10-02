import type { PRComment } from '../../../../shared/github/comment-types'
import type { DiffComment } from '../../../../shared/diff-comment-types'

/**
 * The review-thread half of an inline comment.
 *
 * Present only on GitHub PR review threads; a local note has no `thread`, which is what keeps the
 * note card (edit, delete, hand to an agent) and the review card (reply, resolve, collapse) apart
 * without a second zone pipeline.
 */
export type DecoratedPRCommentThread = {
  /** Absent when GitHub returned the review comment without a thread; reply and resolve need one. */
  threadId?: string
  /** Numeric id of the comment a reply attaches to. */
  rootCommentId: number
  replies: readonly PRComment[]
  isResolved: boolean
}

export type DecoratedDiffComment = DiffComment & {
  author?: string
  authorAvatarUrl?: string
  createdAtLabel?: string
  url?: string
  canDelete?: boolean
  canEdit?: boolean
  /** True when GitHub identifies the author as a bot, so the card can label it. */
  isBot?: boolean
  thread?: DecoratedPRCommentThread
}
