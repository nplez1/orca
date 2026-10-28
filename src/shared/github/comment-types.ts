import type { GitHubRepositoryIdentity } from './pull-request-types'

export type GitHubReactionContent =
  | '+1'
  | '-1'
  | 'laugh'
  | 'confused'
  | 'heart'
  | 'hooray'
  | 'rocket'
  | 'eyes'

export type GitHubReaction = {
  content: GitHubReactionContent
  count: number
  viewerHasReacted?: boolean
}

/** A review submission's verdict. GraphQL `PullRequestReviewState` and REST `pulls/{n}/reviews`
 *  agree on these spellings. */
export type GitHubReviewState =
  | 'APPROVED'
  | 'CHANGES_REQUESTED'
  | 'COMMENTED'
  | 'DISMISSED'
  | 'PENDING'

/** Unknown host spellings degrade to `undefined`, which reads as "not a verdict" — never as a
 *  verdict the panel would have to guess the meaning of. */
export function parseGitHubReviewState(state: unknown): GitHubReviewState | undefined {
  switch (state) {
    case 'APPROVED':
    case 'CHANGES_REQUESTED':
    case 'COMMENTED':
    case 'DISMISSED':
    case 'PENDING':
      return state
    default:
      return undefined
  }
}

export type PRComment = {
  id: number
  author: string
  authorAvatarUrl: string
  body: string
  createdAt: string
  url: string
  reactions?: GitHubReaction[]
  /** GraphQL node ID for GitHub comments that support reaction mutations. */
  reactionSubjectId?: string
  /** File path for inline review comments (absent for top-level conversation comments). */
  path?: string
  /** Inline review thread’s GraphQL ID, used to resolve/unresolve it; absent for conversation comments. */
  threadId?: string
  /** Whether the review thread has been resolved. Only meaningful when threadId is set. */
  isResolved?: boolean
  /** True when GitHub no longer maps the thread to the current diff. */
  isOutdated?: boolean
  /** End line of the review annotation (1-based). */
  line?: number
  /** Start line of the review annotation range (1-based). Absent for single-line comments. */
  startLine?: number
  /** The verdict this entry carries as a review submission. Absent for conversation comments and
   *  inline review comments, which have no verdict of their own. Present on a review submission
   *  even when it has an empty body — an approval with no comment is a verdict, not noise. */
  reviewState?: GitHubReviewState
  /** True when GitHub identifies the author as a bot (REST `user.type === 'Bot'` or
   *  GraphQL `__typename === 'Bot'`). Preferred over login-string heuristics because
   *  third-party review bots (e.g. qodo-ai-reviewer, coderabbitai) don't follow a
   *  predictable naming convention. Absent when the data source can't report it
   *  (non-GitHub fallbacks via `gh pr view`). */
  isBot?: boolean
}

export type GitHubIssueTimelineTarget = {
  type: 'issue' | 'pr'
  number: number
  title: string
  url: string
  repository?: string
}

export type GitHubIssueTimelineItem = {
  id: string
  event:
    | 'assigned'
    | 'unassigned'
    | 'mentioned'
    | 'cross-referenced'
    | 'closed'
    | 'reopened'
    | 'moved_columns_in_project'
  actor: string
  actorAvatarUrl: string
  createdAt: string
  assignee?: string
  source?: GitHubIssueTimelineTarget
  closer?: GitHubIssueTimelineTarget
  stateReason?: string | null
  previousColumnName?: string | null
  columnName?: string | null
  projectName?: string | null
}

export type GitHubCommentResult = { ok: true; comment: PRComment } | { ok: false; error: string }

export type GitHubPRReviewCommentInput = {
  repoPath: string
  prRepo?: GitHubRepositoryIdentity | null
  prNumber: number
  commitId: string
  path: string
  line: number
  startLine?: number
  body: string
}
