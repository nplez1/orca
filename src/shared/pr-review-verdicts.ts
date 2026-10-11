import type { GitHubReviewState, PRComment } from './github/comment-types'
import { isBotPRComment } from './pr-comment-audience'

/**
 * One reviewer's standing decision on a PR, reduced from the review submissions the comments
 * payload already carries. The panel reads this rather than `PRInfo.reviewDecision`, which says
 * *what* was decided but never *who* decided it.
 */
export type PRReviewVerdict = {
  /** `PRComment.id` of the review submission — the comment row this verdict anchors to. */
  id: number
  login: string
  avatarUrl: string
  state: GitHubReviewState
  /** True when the review carried a comment body, so the verdict can jump to its comment row. */
  hasBody: boolean
  createdAt: string
  isBot: boolean
}

/** Most actionable first: a change request is the state that must not be missed. */
const VERDICT_RANK: Record<GitHubReviewState, number> = {
  CHANGES_REQUESTED: 0,
  APPROVED: 1,
  COMMENTED: 2,
  DISMISSED: 3,
  PENDING: 4
}

/**
 * A review submission is a verdict, not conversation. Only the ones carrying a body belong in the
 * comment timeline; the rest exist solely as a verdict row, so they must not be counted, grouped,
 * queued for the agent, or rendered as an empty card.
 */
export function isPRReviewVerdictOnlyComment(comment: PRComment): boolean {
  return comment.reviewState !== undefined && comment.body.trim().length === 0
}

/** Drops the verdict-only review submissions, leaving the entries the comment list renders. */
export function filterPRCommentListEntries(comments: readonly PRComment[]): PRComment[] {
  return comments.filter((comment) => !isPRReviewVerdictOnlyComment(comment))
}

/**
 * Whether a state settles a reviewer's position.
 *
 * Why: a later neutral review does not retract an earlier decision — GitHub keeps an approval
 * until it is dismissed or changed — so `COMMENTED`/`PENDING` only supersede each other. Without
 * this, approve-then-comment would render as a neutral review and hide a live approval.
 */
function isDecisiveReviewState(state: GitHubReviewState): boolean {
  return state !== 'COMMENTED' && state !== 'PENDING'
}

function verdictTimestamp(createdAt: string): number {
  const timestamp = Date.parse(createdAt)
  return Number.isNaN(timestamp) ? 0 : timestamp
}

function supersedesVerdict(next: PRReviewVerdict, current: PRReviewVerdict): boolean {
  const nextDecisive = isDecisiveReviewState(next.state)
  if (nextDecisive !== isDecisiveReviewState(current.state)) {
    return nextDecisive
  }
  return verdictTimestamp(next.createdAt) >= verdictTimestamp(current.createdAt)
}

export function comparePRReviewVerdicts(left: PRReviewVerdict, right: PRReviewVerdict): number {
  return (
    VERDICT_RANK[left.state] - VERDICT_RANK[right.state] ||
    verdictTimestamp(right.createdAt) - verdictTimestamp(left.createdAt) ||
    left.login.localeCompare(right.login)
  )
}

/**
 * One verdict per reviewer, from the review submissions in `comments`.
 *
 * Reviewer identity has to come from here: `PRInfo` carries `reviewDecision` but no per-reviewer
 * list, and `GitHubWorkItem.latestReviews` is on the work-item path the Checks panel does not read.
 */
export function getPRReviewVerdicts(
  comments: readonly PRComment[],
  botAuthorOverrides?: ReadonlySet<string>
): PRReviewVerdict[] {
  const byLogin = new Map<string, PRReviewVerdict>()
  for (const comment of comments) {
    const state = comment.reviewState
    if (state === undefined) {
      continue
    }
    const login = comment.author.trim()
    if (!login) {
      continue
    }
    // Why: the same author check the comment list uses, so bot strictness cannot drift between
    // the verdict block and the timeline below it.
    const candidate: PRReviewVerdict = {
      id: comment.id,
      login,
      avatarUrl: comment.authorAvatarUrl,
      state,
      hasBody: comment.body.trim().length > 0,
      createdAt: comment.createdAt,
      isBot: isBotPRComment(comment, botAuthorOverrides)
    }
    const key = login.toLowerCase()
    const current = byLogin.get(key)
    if (!current || supersedesVerdict(candidate, current)) {
      byLogin.set(key, candidate)
    }
  }
  return [...byLogin.values()].sort(comparePRReviewVerdicts)
}
