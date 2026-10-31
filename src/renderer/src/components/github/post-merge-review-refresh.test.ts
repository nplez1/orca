import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../shared/repo-types'
import { prCacheKey } from '@/store/github/cache-identity'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review-cache-identity'
import {
  createTestStore,
  makePR,
  makePRRefreshWorktree
} from '@/store/slices/github-slice-test-harness'
import {
  __clearPostMergeRefreshesForTests,
  POST_MERGE_REFRESH_DEADLINE_MS,
  POST_MERGE_REFRESH_INTERVAL_MS,
  POST_MERGE_REFRESH_MAX_EMPTY_OBSERVATIONS,
  resolvePostMergeReviewTarget,
  startPostMergeReviewPolling,
  startPostMergeReviewRefresh,
  type MergedReviewObservation
} from './post-merge-review-refresh'

const repo: Repo = { id: 'repo-1', path: '/repo', displayName: 'repo', badgeColor: '', addedAt: 0 }
const openReview: MergedReviewObservation = { state: 'open', failed: false }
const mergedReview: MergedReviewObservation = { state: 'merged', failed: false }

describe('post-merge review polling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks once, then stops as soon as the review reads merged', async () => {
    let observation = openReview
    const refresh = vi.fn(async () => {
      observation = mergedReview
    })
    startPostMergeReviewPolling({ observe: () => observation, refresh })

    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(POST_MERGE_REFRESH_INTERVAL_MS * 4)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('keeps asking while the review is still open, easing the cadence as it goes', async () => {
    const refresh = vi.fn(async () => {})
    startPostMergeReviewPolling({ observe: () => openReview, refresh })

    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(POST_MERGE_REFRESH_INTERVAL_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
    // The second wait doubles, so a merge that never shows up costs a handful of lookups, not thirty.
    await vi.advanceTimersByTimeAsync(POST_MERGE_REFRESH_INTERVAL_MS * 2)
    expect(refresh).toHaveBeenCalledTimes(3)
  })

  it('stops when the branch has no review to follow at all', async () => {
    const refresh = vi.fn(async () => {})
    startPostMergeReviewPolling({
      observe: () => ({ state: null, failed: false }),
      refresh,
      intervalMs: 10
    })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(refresh).toHaveBeenCalledTimes(POST_MERGE_REFRESH_MAX_EMPTY_OBSERVATIONS)
  })

  it('stops once a provider error is recorded instead of hammering a failing lookup', async () => {
    let observation = openReview
    const refresh = vi.fn(async () => {
      observation = { state: null, failed: true }
    })
    startPostMergeReviewPolling({ observe: () => observation, refresh })

    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(POST_MERGE_REFRESH_INTERVAL_MS * 3)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('stops after a thrown lookup, which is how the hosted-review path reports failure', async () => {
    const refresh = vi.fn(async () => {
      throw new Error('lookup unavailable')
    })
    startPostMergeReviewPolling({ observe: () => openReview, refresh })

    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(POST_MERGE_REFRESH_INTERVAL_MS * 3)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('still attempts a lookup when the cache already holds a stale error', async () => {
    // A merge just succeeded, so a recorded error belongs to the previous lookup, not this one.
    let observation: MergedReviewObservation = { state: null, failed: true }
    const refresh = vi.fn(async () => {
      observation = mergedReview
    })
    startPostMergeReviewPolling({ observe: () => observation, refresh })

    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('gives up at the deadline instead of polling forever', async () => {
    const refresh = vi.fn(async () => {})
    startPostMergeReviewPolling({ observe: () => openReview, refresh })

    await vi.advanceTimersByTimeAsync(POST_MERGE_REFRESH_DEADLINE_MS * 3)
    const calls = refresh.mock.calls.length
    expect(calls).toBeGreaterThan(1)
    // The doubling cadence keeps a merge that never becomes visible to a handful of lookups.
    expect(calls).toBeLessThanOrEqual(8)
    await vi.advanceTimersByTimeAsync(POST_MERGE_REFRESH_DEADLINE_MS)
    expect(refresh).toHaveBeenCalledTimes(calls)
  })

  it('stops scheduling after the caller cancels', async () => {
    const refresh = vi.fn(async () => {})
    const stop = startPostMergeReviewPolling({ observe: () => openReview, refresh })

    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(1)
    stop()
    await vi.advanceTimersByTimeAsync(POST_MERGE_REFRESH_INTERVAL_MS * 5)
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})

describe('post-merge review refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    __clearPostMergeRefreshesForTests()
    vi.clearAllMocks()
  })
  afterEach(() => {
    __clearPostMergeRefreshesForTests()
    vi.useRealTimers()
  })

  function setup(worktreeOverrides: Parameters<typeof makePRRefreshWorktree>[0] = {}) {
    const worktree = makePRRefreshWorktree(worktreeOverrides)
    const store = createTestStore()
    store.setState({
      repos: [repo],
      settings: null,
      worktreesByRepo: { [repo.id]: [worktree] },
      activeWorktreeId: null
    })
    return { store, worktree }
  }

  function keyFor(branch: string): string {
    return prCacheKey(repo.path, repo.id, branch, null, null, null, true)
  }

  type FetchOptions = NonNullable<Parameters<AppState['fetchPRForBranch']>[2]>

  type RecordedCall = {
    branch: string
    force: boolean
    reason: FetchOptions['reason'] | null
    repoId: string | null
    worktreeId: string | null
    linkedPRNumber: number | null
    fallbackPRNumber: number | null
    fallbackPRSource: FetchOptions['fallbackPRSource'] | null
  }

  function record(branch: string, options: FetchOptions | undefined): RecordedCall {
    return {
      branch,
      force: options?.force === true,
      reason: options?.reason ?? null,
      repoId: options?.repoId ?? null,
      worktreeId: options?.worktreeId ?? null,
      linkedPRNumber: options?.linkedPRNumber ?? null,
      fallbackPRNumber: options?.fallbackPRNumber ?? null,
      fallbackPRSource: options?.fallbackPRSource ?? null
    }
  }

  function stubRefresh(store: ReturnType<typeof setup>['store']) {
    const calls: RecordedCall[] = []
    const refresh: AppState['fetchPRForBranch'] = async (_repoPath, branch, options) => {
      calls.push(record(branch, options))
      return null
    }
    store.setState({ fetchPRForBranch: refresh })
    return calls
  }

  it('follows the workspace that links the merged PR and forces a manual lookup', async () => {
    const { store, worktree } = setup({ linkedPR: 42, branch: 'feature/linked' })
    const calls = stubRefresh(store)

    startPostMergeReviewRefresh(
      { repoPath: repo.path, repoId: repo.id, prNumber: 42 },
      { getState: store.getState, intervalMs: 10 }
    )

    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      branch: 'feature/linked',
      force: true,
      reason: 'manual',
      repoId: repo.id,
      worktreeId: worktree.id,
      linkedPRNumber: 42,
      fallbackPRNumber: null
    })
  })

  it('finds a branch-discovered PR from the entry the workspace already shows', async () => {
    const { store } = setup({ linkedPR: null, branch: 'feature/discovered' })
    const calls = stubRefresh(store)
    store.setState({
      prCache: { [keyFor('feature/discovered')]: { data: makePR({ number: 7 }), fetchedAt: 1 } }
    })

    startPostMergeReviewRefresh(
      { repoPath: repo.path, repoId: repo.id, prNumber: 7 },
      { getState: store.getState, intervalMs: 10 }
    )

    await vi.advanceTimersByTimeAsync(0)
    // Why the explicit fallback: nothing durable links this PR, so only a fallback number lets the
    // lookup return the merged PR instead of declaring the branch review-less.
    expect(calls[0]).toMatchObject({
      branch: 'feature/discovered',
      linkedPRNumber: null,
      fallbackPRNumber: 7,
      fallbackPRSource: 'explicit'
    })
  })

  it('stops polling once the workspace review reads merged', async () => {
    const { store, worktree } = setup({ linkedPR: 42, branch: 'feature/linked' })
    const calls = stubRefresh(store)
    store.setState({
      prCache: { [keyFor('feature/linked')]: { data: makePR({ state: 'open' }), fetchedAt: 1 } }
    })

    startPostMergeReviewRefresh(
      { repoPath: repo.path, repoId: repo.id, prNumber: 42 },
      { getState: store.getState, intervalMs: 10 }
    )

    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    store.setState({
      prCache: {
        [keyFor(worktree.branch)]: { data: makePR({ state: 'merged' }), fetchedAt: 2 }
      }
    })
    await vi.advanceTimersByTimeAsync(50)
    expect(calls).toHaveLength(1)
  })

  it('replaces an earlier burst for the same merged PR', async () => {
    const { store } = setup({ linkedPR: 42, branch: 'feature/linked' })
    const calls = stubRefresh(store)
    const target = { repoPath: repo.path, repoId: repo.id, prNumber: 42 }
    const options = { getState: store.getState, intervalMs: 10 }

    startPostMergeReviewRefresh(target, options)
    startPostMergeReviewRefresh(target, options)

    // Each start attempts immediately, so both are on the wire before the second one replaces the
    // first; only the replacement keeps scheduling. Two live loops would keep making calls.
    await vi.advanceTimersByTimeAsync(20)
    expect(calls).toHaveLength(3)
  })

  it('does nothing when no branch can be resolved', async () => {
    const store = createTestStore()
    store.setState({ repos: [repo], settings: null, worktreesByRepo: {}, activeWorktreeId: null })
    const calls = stubRefresh(store)

    startPostMergeReviewRefresh(
      { repoPath: repo.path, repoId: repo.id, prNumber: 42 },
      { getState: store.getState, intervalMs: 10 }
    )
    await vi.advanceTimersByTimeAsync(50)
    expect(calls).toHaveLength(0)
  })

  it('resolves an explicitly named branch for a workspace that has none cached yet', () => {
    const { store } = setup()
    const resolved = resolvePostMergeReviewTarget(store.getState(), {
      repoPath: repo.path,
      repoId: repo.id,
      prNumber: 42,
      worktreeId: 'wt-pr-refresh'
    })

    expect(resolved).toMatchObject({
      repoId: repo.id,
      branch: 'feature/pr-refresh',
      worktree: expect.objectContaining({ id: 'wt-pr-refresh' })
    })
  })

  it('finds a merge-request workspace from its hosted-review entry when no worktree is named', async () => {
    const { store, worktree } = setup({ linkedGitLabMR: 7, linkedPR: null, branch: 'feature/mr' })
    const hostedCalls: string[] = []
    const fetchHostedReviewForBranch: AppState['fetchHostedReviewForBranch'] = async (
      _repoPath,
      branch
    ) => {
      hostedCalls.push(branch)
      return null
    }
    store.setState({
      fetchHostedReviewForBranch,
      hostedReviewCache: {
        [getHostedReviewCacheKey(repo.path, worktree.branch, null, repo.id, null, null, true)]: {
          data: {
            provider: 'gitlab',
            number: 7,
            title: 'MR',
            state: 'open',
            url: 'https://gitlab.com/acme/orca/-/merge_requests/7',
            status: 'success',
            updatedAt: '',
            mergeable: 'MERGEABLE'
          },
          fetchedAt: 1
        }
      }
    })

    startPostMergeReviewRefresh(
      { repoPath: repo.path, repoId: repo.id, prNumber: 7 },
      { getState: store.getState, intervalMs: 10 }
    )

    await vi.advanceTimersByTimeAsync(0)
    expect(hostedCalls).toEqual([worktree.branch])
  })

  it('stops when the provider paused the lookup instead of churning every second', async () => {
    const { store } = setup({ linkedPR: 42, branch: 'feature/linked' })
    const calls = stubRefresh(store)
    store.setState({
      prCache: { [keyFor('feature/linked')]: { data: makePR({ state: 'open' }), fetchedAt: 1 } },
      prRefreshStates: {
        [keyFor('feature/linked')]: {
          status: 'paused',
          reason: 'manual',
          updatedAt: Date.now(),
          pausedUntil: Date.now() + 900_000
        }
      }
    })

    startPostMergeReviewRefresh(
      { repoPath: repo.path, repoId: repo.id, prNumber: 42 },
      { getState: store.getState, intervalMs: 10 }
    )

    await vi.advanceTimersByTimeAsync(200)
    expect(calls).toHaveLength(1)
  })

  it('drives the hosted-review cache for a merge request on another forge', async () => {
    const { store, worktree } = setup({ linkedGitLabMR: 7, linkedPR: null, branch: 'feature/mr' })
    store.setState({
      hostedReviewCache: {
        [getHostedReviewCacheKey(repo.path, worktree.branch, null, repo.id, null, null, true)]: {
          data: {
            provider: 'gitlab',
            number: 7,
            title: 'MR',
            state: 'open',
            url: 'https://gitlab.com/acme/orca/-/merge_requests/7',
            status: 'success',
            updatedAt: '',
            mergeable: 'MERGEABLE'
          },
          fetchedAt: 1
        }
      }
    })
    const hostedCalls: { branch: string; force: boolean; admissionTier: string | null }[] = []
    const fetchHostedReviewForBranch: AppState['fetchHostedReviewForBranch'] = async (
      _repoPath,
      branch,
      options
    ) => {
      hostedCalls.push({
        branch,
        force: options?.force === true,
        admissionTier: options?.admissionTier ?? null
      })
      return null
    }
    store.setState({ fetchHostedReviewForBranch })
    startPostMergeReviewRefresh(
      { repoPath: repo.path, repoId: repo.id, prNumber: 7, worktreeId: worktree.id },
      { getState: store.getState, intervalMs: 10 }
    )

    await vi.advanceTimersByTimeAsync(0)
    expect(hostedCalls[0]).toEqual({
      branch: worktree.branch,
      force: true,
      admissionTier: 'interactive'
    })
  })
})
