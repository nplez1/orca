import type { AppState } from '@/store/types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { HostedReviewState } from '../../../../shared/hosted-review'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { useAppStore } from '@/store'
import { prCacheKey } from '@/store/github/cache-identity'
import { findWorktreeById } from '@/store/github/worktree-refresh'
import { settingsForGitHubRepoOwner } from '@/store/github/work-item-routing'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review-cache-identity'
import { getGitHubRepoLookupIndex } from '@/store/slices/github-repo-lookup-index'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'

/**
 * Why fast: the merge call already returned `ok`, so the merge is on the provider and only the
 * cached review state is behind. The user just acted and is watching this glyph, so the gap a
 * 60-second cadence leaves here is the one they read as "the merge did nothing".
 */
export const POST_MERGE_REFRESH_INTERVAL_MS = 1_500

/** Why a deadline: a merge that never becomes visible must not turn into an unbounded poll. */
export const POST_MERGE_REFRESH_DEADLINE_MS = 45_000

/** Attempts that still see no review at all before the burst hands back to the ordinary cadence. */
export const POST_MERGE_REFRESH_MAX_EMPTY_OBSERVATIONS = 5

export type PostMergeReviewRefreshTarget = {
  repoPath: string
  repoId?: string | null
  prNumber: number
  /** Set by a surface that already renders this workspace, so its branch needs no discovery. */
  worktreeId?: string | null
  branch?: string | null
}

export type MergedReviewObservation = {
  state: HostedReviewState | null
  /** The lookup settled without a usable answer: a provider error, or a rate-limit pause. */
  failed: boolean
}

type TimerHandle = ReturnType<typeof setTimeout>

export type PostMergeRefreshLoopDeps = {
  observe: () => MergedReviewObservation
  refresh: () => Promise<unknown>
  /** Notified once when the loop stops for any reason, so callers can drop their bookkeeping. */
  onStop?: () => void
  now?: () => number
  schedule?: (run: () => void, delayMs: number) => TimerHandle
  cancelSchedule?: (handle: TimerHandle) => void
  intervalMs?: number
  deadlineMs?: number
  maxEmptyObservations?: number
}

function isSettled(observation: MergedReviewObservation): boolean {
  // Closed is terminal too: a merge that lands as "closed" is not going to become merged, and a
  // reopened review starts its own cycle.
  return observation.state === 'merged' || observation.state === 'closed'
}

/**
 * Re-asks until the workspace's review reaches a settled state, the lookup fails, or the deadline
 * passes. The cadence doubles from `intervalMs` so the first few answers are seconds apart without
 * spending thirty lookups on a merge that never becomes visible.
 */
export function startPostMergeReviewPolling(deps: PostMergeRefreshLoopDeps): () => void {
  const now = deps.now ?? Date.now
  const schedule = deps.schedule ?? ((run: () => void, delayMs: number) => setTimeout(run, delayMs))
  const cancelSchedule = deps.cancelSchedule ?? ((handle: TimerHandle) => clearTimeout(handle))
  const intervalMs = deps.intervalMs ?? POST_MERGE_REFRESH_INTERVAL_MS
  const maxEmptyObservations =
    deps.maxEmptyObservations ?? POST_MERGE_REFRESH_MAX_EMPTY_OBSERVATIONS
  const deadlineAt = now() + (deps.deadlineMs ?? POST_MERGE_REFRESH_DEADLINE_MS)
  let stopped = false
  let running = false
  let timer: TimerHandle | null = null
  let attempts = 0
  let emptyObservations = 0

  const stop = (): void => {
    if (stopped) {
      return
    }
    stopped = true
    if (timer !== null) {
      cancelSchedule(timer)
      timer = null
    }
    deps.onStop?.()
  }

  const tick = async (): Promise<void> => {
    if (stopped || running) {
      return
    }
    running = true
    try {
      // Why the early exit: a merge the cache already reflects needs no lookup, and the caller may
      // have refreshed on its own before starting this burst.
      if (isSettled(deps.observe()) || now() >= deadlineAt) {
        stop()
        return
      }
      attempts += 1
      let refreshThrew = false
      try {
        await deps.refresh()
      } catch {
        // A throw is the only failure signal the hosted-review lookup gives, so it ends the burst
        // rather than being retried into a failing endpoint; the ordinary cadence still runs.
        refreshThrew = true
      }
      if (stopped) {
        return
      }
      const observed = deps.observe()
      if (isSettled(observed) || observed.failed || refreshThrew) {
        stop()
        return
      }
      if (observed.state === null) {
        emptyObservations += 1
        if (emptyObservations >= maxEmptyObservations) {
          stop()
          return
        }
      }
      if (now() >= deadlineAt) {
        stop()
        return
      }
      const delay = Math.min(intervalMs * 2 ** (attempts - 1), intervalMs * 8)
      timer = schedule(() => {
        timer = null
        void tick()
      }, delay)
    } finally {
      running = false
    }
  }

  void tick()
  return stop
}

export type ResolvedPostMergeReviewTarget = {
  repo: Repo | undefined
  repoPath: string
  repoId: string | undefined
  worktree: Worktree | null
  branch: string
  /** The provider-neutral review cache key for this branch. */
  hostedReviewCacheKey: string
  prCacheKey: string
}

function worktreesInRepo(state: AppState, repoId: string | undefined): Worktree[] {
  if (!repoId) {
    return []
  }
  return selectWorktreesByRepo(state)?.[repoId] ?? []
}

function linksReviewNumber(worktree: Worktree, reviewNumber: number): boolean {
  return (
    worktree.linkedPR === reviewNumber ||
    worktree.linkedGitLabMR === reviewNumber ||
    worktree.linkedBitbucketPR === reviewNumber ||
    worktree.linkedAzureDevOpsPR === reviewNumber ||
    worktree.linkedGiteaPR === reviewNumber
  )
}

/**
 * Finds the workspace the merged PR/MR belongs to. The merge surfaces do not all carry a branch,
 * and the icon is per-workspace, so the branch is recovered from what the workspace already shows:
 * a durable link first, then the branch whose cached review is that number.
 */
export function resolvePostMergeReviewTarget(
  state: AppState,
  target: PostMergeReviewRefreshTarget
): ResolvedPostMergeReviewTarget | null {
  const repoLookup = getGitHubRepoLookupIndex(state.repos)
  const repo = target.repoId
    ? repoLookup.findById(target.repoId)
    : repoLookup.findByPath(target.repoPath)
  const repoId = target.repoId ?? repo?.id
  const settings = settingsForGitHubRepoOwner(state.settings, repo)
  const withRepoOwner = repo !== undefined
  const cacheKeyFor = (branch: string): string =>
    prCacheKey(
      target.repoPath,
      repoId,
      branch,
      settings,
      repo?.connectionId,
      repo?.executionHostId,
      withRepoOwner
    )
  const hostedKeyFor = (branch: string): string =>
    getHostedReviewCacheKey(
      target.repoPath,
      branch,
      settings,
      repoId,
      repo?.connectionId,
      repo?.executionHostId,
      withRepoOwner
    )
  const resolveWorktree = (): Worktree | null => {
    const explicit = target.worktreeId ? findWorktreeById(state, target.worktreeId) : null
    if (explicit?.branch) {
      return explicit
    }
    const candidates = worktreesInRepo(state, repoId).filter((worktree) => Boolean(worktree.branch))
    const linked = candidates.filter((worktree) => linksReviewNumber(worktree, target.prNumber))
    if (linked.length === 1) {
      return linked[0]
    }
    // Why both caches: a GitHub PR is cached per branch, while a GitLab/Bitbucket/Azure/Gitea
    // review only ever lives in the hosted-review cache.
    const showing = candidates.filter(
      (worktree) =>
        state.prCache[cacheKeyFor(worktree.branch)]?.data?.number === target.prNumber ||
        state.hostedReviewCache[hostedKeyFor(worktree.branch)]?.data?.number === target.prNumber
    )
    return showing.length === 1 ? showing[0] : explicit
  }
  const worktree = resolveWorktree()
  const branch = target.branch || worktree?.branch || ''
  if (!branch) {
    return null
  }
  return {
    repo,
    // Why: some merge surfaces only carry a repo id, and an empty path would reach the lookup.
    repoPath: target.repoPath || repo?.path || '',
    repoId,
    worktree,
    branch,
    hostedReviewCacheKey: hostedKeyFor(branch),
    prCacheKey: cacheKeyFor(branch)
  }
}

export type PostMergeReviewRefreshOptions = {
  getState?: () => AppState
  intervalMs?: number
  deadlineMs?: number
}

const activePostMergeRefreshes = new Map<string, () => void>()

function stopExistingRefresh(key: string): void {
  activePostMergeRefreshes.get(key)?.()
  activePostMergeRefreshes.delete(key)
}

/** @internal - exposed for tests only */
export function __clearPostMergeRefreshesForTests(): void {
  // Snapshot first: each stop drops its own entry from the map.
  for (const stop of Array.from(activePostMergeRefreshes.values())) {
    stop()
  }
  activePostMergeRefreshes.clear()
}

/**
 * The checks pane and the sidebar glyph both render the PR cache for GitHub branches and the
 * hosted-review cache for every other forge, so the burst watches — and re-asks — whichever one
 * the merged review came from.
 */
export function startPostMergeReviewRefresh(
  target: PostMergeReviewRefreshTarget,
  options: PostMergeReviewRefreshOptions = {}
): () => void {
  const getState = options.getState ?? (() => useAppStore.getState())
  const resolved = resolvePostMergeReviewTarget(getState(), target)
  if (!resolved) {
    // A folder workspace or an unknown branch has no review cache entry to drive.
    return () => {}
  }
  const key = `${resolved.repoId ?? resolved.repoPath}::${resolved.branch}::${target.prNumber}`
  stopExistingRefresh(key)
  const { repo, worktree, branch, repoPath } = resolved
  const usesHostedReview = (): boolean => {
    const state = getState()
    const pr = state.prCache[resolved.prCacheKey]?.data
    if (pr?.number === target.prNumber) {
      return false
    }
    const hosted = state.hostedReviewCache[resolved.hostedReviewCacheKey]?.data
    return hosted != null && hosted.provider !== 'github'
  }
  let stopFn: (() => void) | null = null
  let stoppedBeforeRegistration = false
  const forget = (): void => {
    stoppedBeforeRegistration = true
    if (stopFn !== null && activePostMergeRefreshes.get(key) === stopFn) {
      activePostMergeRefreshes.delete(key)
    }
  }
  const stop = startPostMergeReviewPolling({
    intervalMs: options.intervalMs,
    deadlineMs: options.deadlineMs,
    onStop: forget,
    observe: () => {
      const state = getState()
      const usesHosted = usesHostedReview()
      const data = usesHosted
        ? state.hostedReviewCache[resolved.hostedReviewCacheKey]?.data
        : state.prCache[resolved.prCacheKey]?.data
      const refreshState = usesHosted
        ? undefined
        : state.getEffectiveGitHubPRRefreshState(resolved.prCacheKey)
      return {
        state: data?.state ?? null,
        // Why paused counts: a paused refresh is a rate-limit hold, so re-entering it every second
        // until the deadline only churns the queue — the ordinary cadence picks it back up.
        failed: refreshState?.status === 'error' || refreshState?.status === 'paused'
      }
    },
    refresh: async () => {
      const state = getState()
      if (usesHostedReview()) {
        await state.fetchHostedReviewForBranch(repoPath, branch, {
          force: true,
          admissionTier: 'interactive',
          repoId: resolved.repoId,
          repoOwnerExecutionHostId: repo ? getRepoExecutionHostId(repo) : undefined,
          currentHeadOid: worktree?.head ?? null,
          active: true
        })
        return
      }
      const linkedPRNumber = worktree?.linkedPR ?? null
      await state.fetchPRForBranch(repoPath, branch, {
        force: true,
        reason: 'manual',
        repoId: resolved.repoId,
        worktreeId: worktree?.id,
        linkedPRNumber,
        // Why: a branch-discovered PR is not linked in metadata, and only an explicit fallback lets
        // the lookup return the merged PR rather than declaring the branch review-less.
        fallbackPRNumber: linkedPRNumber == null ? target.prNumber : null,
        fallbackPRSource: linkedPRNumber == null ? 'explicit' : null
      })
    }
  })
  stopFn = stop
  if (!stoppedBeforeRegistration) {
    activePostMergeRefreshes.set(key, stop)
  }
  return () => {
    stop()
    if (activePostMergeRefreshes.get(key) === stop) {
      activePostMergeRefreshes.delete(key)
    }
  }
}
