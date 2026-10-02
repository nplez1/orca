import type { PRComment } from '../../../../shared/github/comment-types'
import { getPRCommentGroupRoot, groupPRComments } from '../../../../shared/pr-comment-groups'

/** Zone key prefix for an inline PR thread. Doubles as the pending-reveal id used by jump-to-comment. */
const PR_COMMENT_INLINE_ID_PREFIX = 'github-pr-comment:'

export type PRCommentInlineThread = {
  /** Stable across refreshes: it derives from the root comment's id, which GitHub keeps. */
  id: string
  /** Absent for a review comment GitHub returned without a thread (reply/resolve are unavailable then). */
  threadId?: string
  path: string
  line: number
  startLine?: number
  isResolved: boolean
  root: PRComment
  replies: PRComment[]
}

export function getPRCommentInlineId(commentId: number): string {
  return `${PR_COMMENT_INLINE_ID_PREFIX}${commentId}`
}

/**
 * Builds the threads that can be drawn on a line, in reading order.
 *
 * Outdated threads are dropped rather than relocated: GitHub keeps their original line number, so
 * drawing one now attaches it to whatever code has since taken that line.
 */
export function buildPRCommentInlineThreads(
  comments: readonly PRComment[]
): PRCommentInlineThread[] {
  const threads: PRCommentInlineThread[] = []
  for (const group of groupPRComments(comments)) {
    const root = getPRCommentGroupRoot(group)
    if (root.isOutdated || !root.path || typeof root.line !== 'number') {
      continue
    }
    threads.push({
      id: getPRCommentInlineId(root.id),
      threadId: group.kind === 'thread' ? group.threadId : undefined,
      path: root.path,
      line: root.line,
      startLine: root.startLine,
      isResolved: root.isResolved === true,
      root,
      replies: group.kind === 'thread' ? group.replies : []
    })
  }
  return threads.sort((a, b) => a.line - b.line || a.id.localeCompare(b.id))
}

export function groupPRCommentInlineThreadsByPath(
  threads: readonly PRCommentInlineThread[]
): Map<string, PRCommentInlineThread[]> {
  const byPath = new Map<string, PRCommentInlineThread[]>()
  for (const thread of threads) {
    const existing = byPath.get(thread.path)
    if (existing) {
      existing.push(thread)
    } else {
      byPath.set(thread.path, [thread])
    }
  }
  return byPath
}

/**
 * Whether two commit ids name the same commit.
 *
 * Git and GitHub report the same commit at different lengths (an abbreviated local HEAD against
 * GitHub's full SHA), so a short form counts as a match once it is long enough to be unambiguous.
 */
export function commitOidsMatch(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  const a = left?.trim().toLowerCase() ?? ''
  const b = right?.trim().toLowerCase() ?? ''
  if (!a || !b) {
    return false
  }
  if (a === b) {
    return true
  }
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a]
  return shorter.length >= 7 && longer.startsWith(shorter)
}

export type PRCommentInlineBlocker =
  | { kind: 'head-mismatch'; worktreeHeadOid: string; commentsHeadSha: string }
  | { kind: 'unverified-head' }

/**
 * Why inline placement is suppressed, or null when it is safe.
 *
 * A comment's `line` is a line number in the PR's head commit, so it may only be drawn once the
 * commit being shown is known to be that same commit. An unverifiable head is treated as a
 * mismatch: a comment on the wrong line reads as a fact about the code, which is worse than
 * asking the user to open the file from the Checks pane instead.
 *
 * A user-facing `enabled: false` is not reported as a blocker — that was a deliberate choice and
 * does not deserve a warning.
 */
export function resolvePRCommentInlineBlocker(input: {
  enabled: boolean
  /** Resolved HEAD of the worktree the editor is showing. */
  worktreeHeadOid: string | null | undefined
  /** Head the cached comments were fetched against, as recorded by `fetchPRComments`. */
  commentsHeadSha: string | null | undefined
}): PRCommentInlineBlocker | null {
  if (!input.enabled) {
    return null
  }
  const worktreeHeadOid = input.worktreeHeadOid?.trim() ?? ''
  const commentsHeadSha = input.commentsHeadSha?.trim() ?? ''
  if (!worktreeHeadOid || !commentsHeadSha) {
    return { kind: 'unverified-head' }
  }
  if (commitOidsMatch(worktreeHeadOid, commentsHeadSha)) {
    return null
  }
  return { kind: 'head-mismatch', worktreeHeadOid, commentsHeadSha }
}
