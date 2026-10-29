import { useMemo } from 'react'
import type { AppState } from '@/store/types'
import type { GitHubOwnerRepo } from '../../../../shared/github/pull-request-types'
import type { PRComment } from '../../../../shared/github/comment-types'
import { useAppStore } from '@/store'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import {
  getGitHubPRCacheKey,
  getGitHubRepoCacheKey
} from '../../../../shared/github/github-cache-key'
import { prCommentsCacheSuffix } from '@/store/github/cache-identity'
import { isGitHubPRSuppressed } from '../../../../shared/worktree/github-pr-suppression'
import { isPRCommentsInlineEnabled } from '@/lib/pr-comment-inline-setting'
import { isStaleMergedGitHubReviewForHead } from '@/store/slices/hosted-review-cache-state'
import { getPRCommentInlineScope } from './pr-comment-inline-comments'
import {
  buildPRCommentInlineThreads,
  groupPRCommentInlineThreadsByPath,
  resolvePRCommentInlineBlocker,
  type PRCommentInlineBlocker,
  type PRCommentInlineThread
} from './pr-comment-inline-threads'

export type WorktreePRCommentInline = {
  /** The global "PR Comments Inline" setting as the user last left it. */
  enabled: boolean
  /** Namespaces these threads away from the worktree's local notes; null with no review. */
  scope: string | null
  /** Threads for inline drawing, or null only when the user turned inline comments off. */
  inlineThreadsByPath: Map<string, PRCommentInlineThread[]> | null
  /** Every thread whether or not inline drawing is on, so a surface can still navigate to one. */
  threadsByPath: Map<string, PRCommentInlineThread[]> | null
  /**
   * Whether the checkout is known to be the revision the comments were resolved against.
   *
   * Advisory only: an unknown or moved head is worth explaining, but it is not a reason to hide the
   * review. The decorator drops the individual threads it cannot place honestly instead.
   */
  blocker: PRCommentInlineBlocker | null
  /** Head the cached comments were fetched against, for the Checks-pane explanation. */
  commentsHeadSha: string | null
  prNumber: number | null
  /** What the review mutations need to address this pull request; null with no review. */
  reviewTarget: {
    repoPath: string
    repoId: string
    prNumber: number
    prRepo: GitHubOwnerRepo | null
  } | null
}

type WorktreePRCommentInlineInput = Pick<
  AppState,
  'worktreesByRepo' | 'repos' | 'settings' | 'prCache' | 'commentsCache'
>

export type BuildPRCommentInlineInput = {
  repoPath: string
  repoId: string
  prNumber: number
  prRepo: GitHubOwnerRepo | null
  comments: readonly PRComment[]
  enabled: boolean
  /**
   * Why placement is unsafe, or null when the revision on screen is known to be the one the
   * comments were fetched against.
   *
   * The caller supplies this rather than the derivation deciding it, because only the caller knows
   * what revision its surface shows: a worktree editor shows a checkout that may have moved, while
   * a pull-request diff shows the reviewed commit by construction.
   */
  blocker: PRCommentInlineBlocker | null
  commentsHeadSha: string | null
}

/** Builds the inline-thread view of a review from an already-resolved set of comments. */
export function buildPRCommentInlineFromComments(
  input: BuildPRCommentInlineInput
): WorktreePRCommentInline {
  const grouped = groupPRCommentInlineThreadsByPath(buildPRCommentInlineThreads(input.comments))
  return {
    enabled: input.enabled,
    scope: getPRCommentInlineScope(input.repoId, input.prNumber),
    // Why: the workspace's active review is always drawn. `blocker` still reports a moved head so
    // the sidebar can explain it, and the decorator refuses any thread whose line is not on screen.
    inlineThreadsByPath: input.enabled ? grouped : null,
    threadsByPath: grouped,
    blocker: input.blocker,
    commentsHeadSha: input.commentsHeadSha,
    prNumber: input.prNumber,
    reviewTarget: {
      repoPath: input.repoPath,
      repoId: input.repoId,
      prNumber: input.prNumber,
      prRepo: input.prRepo
    }
  }
}

const NO_REVIEW: WorktreePRCommentInline = {
  enabled: true,
  scope: null,
  inlineThreadsByPath: null,
  threadsByPath: null,
  blocker: null,
  commentsHeadSha: null,
  prNumber: null,
  reviewTarget: null
}

/**
 * Resolves the review threads a worktree's editor may draw.
 *
 * The review identity comes from the same caches the Checks panel writes — the branch-keyed PR cache
 * and the repo/PR-keyed comments cache — so the sidebar and the editor can never disagree about
 * which pull request a worktree is reviewing.
 *
 * The active review is whatever the Checks pane would show for this worktree — same PR cache, same
 * staleness rule, same suppression list — so the editor and the sidebar can never disagree about
 * which pull request is on screen.
 */
export function deriveWorktreePRCommentInline(
  state: WorktreePRCommentInlineInput,
  worktreeId: string | null | undefined
): WorktreePRCommentInline {
  const enabled = isPRCommentsInlineEnabled(state.settings)
  if (!worktreeId) {
    return { ...NO_REVIEW, enabled }
  }
  const worktree = findWorktreeById(selectWorktreesByRepo(state), worktreeId)
  if (!worktree) {
    return { ...NO_REVIEW, enabled }
  }
  const repo = state.repos.find((candidate) => candidate.id === worktree.repoId)
  if (!repo) {
    return { ...NO_REVIEW, enabled }
  }
  const branch = (worktree.branch ?? '').replace(/^refs\/heads\//, '').trim()
  if (!branch) {
    return { ...NO_REVIEW, enabled }
  }
  const prCacheKey = getGitHubPRCacheKey(
    repo.path,
    repo.id,
    branch,
    state.settings,
    repo.connectionId,
    repo.executionHostId,
    true
  )
  const prEntry = state.prCache[prCacheKey]
  const pr = prEntry?.data ?? null
  if (!pr || isGitHubPRSuppressed(worktree, pr.number)) {
    return { ...NO_REVIEW, enabled }
  }
  // Why: a merged review whose head the checkout has moved past is no longer what the worktree is
  // reviewing, and the Checks pane already hides it — drawing its threads here would contradict it.
  if (isStaleMergedGitHubReviewForHead(prEntry, worktree.head)) {
    return { ...NO_REVIEW, enabled }
  }
  const commentsCacheKey = getGitHubRepoCacheKey(
    repo.path,
    repo.id,
    prCommentsCacheSuffix(pr.number, pr.prRepo),
    state.settings,
    repo.connectionId,
    repo.executionHostId,
    true
  )
  const entry = state.commentsCache[commentsCacheKey]
  const commentsHeadSha = entry?.headSha ?? null
  // Why: reported, never enforced — drawing is what the user asked for; the warning explains a
  // checkout that may have moved, and the decorator withholds only threads with no line to sit on.
  const blocked = resolvePRCommentInlineBlocker({
    enabled,
    worktreeHeadOid: worktree.head,
    commentsHeadSha,
    prHeadSha: pr.headSha
  })
  return buildPRCommentInlineFromComments({
    repoPath: repo.path,
    repoId: repo.id,
    prNumber: pr.number,
    prRepo: pr.prRepo ?? null,
    comments: entry?.data ?? [],
    enabled,
    blocker: blocked,
    commentsHeadSha
  })
}

/**
 * Subscribes to the caches the derivation reads.
 *
 * The five slices are selected whole because every one of them feeds the same derivation and the
 * consumers are editor panes that already re-render on settings and worktree churn; splitting them
 * into per-field selectors would re-run the key derivation five times per store write to save
 * re-renders that are not the cost here.
 */
export function useWorktreePRCommentInline(
  worktreeId: string | null | undefined
): WorktreePRCommentInline {
  // Why: settings and the worktree catalog hydrate asynchronously, and a partial hydration is a
  // real state, not just a test fixture — the module-level fallbacks keep the selector identity
  // stable so an absent slice cannot turn into a re-render loop.
  const worktreesByRepo = useAppStore((s) => selectWorktreesByRepo(s) ?? EMPTY_WORKTREES_BY_REPO)
  const repos = useAppStore((s) => s.repos ?? EMPTY_REPOS)
  const settings = useAppStore((s) => s.settings)
  const prCache = useAppStore((s) => s.prCache ?? EMPTY_PR_CACHE)
  const commentsCache = useAppStore((s) => s.commentsCache ?? EMPTY_COMMENTS_CACHE)
  return useMemo(
    () =>
      deriveWorktreePRCommentInline(
        { worktreesByRepo, repos, settings, prCache, commentsCache },
        worktreeId
      ),
    [commentsCache, prCache, repos, settings, worktreeId, worktreesByRepo]
  )
}

const EMPTY_WORKTREES_BY_REPO: AppState['worktreesByRepo'] = {}
const EMPTY_REPOS: AppState['repos'] = []
const EMPTY_PR_CACHE: AppState['prCache'] = {}
const EMPTY_COMMENTS_CACHE: AppState['commentsCache'] = {}
