import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  makePR,
  makePRRefreshWorktree,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from './github-slice-test-harness'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'

const branch = 'feature/remote-recovery'
const repoId = 'repo-runtime'
const repoPath = '/runtime/repo'
const worktreeId = 'wt-runtime'

const refreshOptions = {
  force: true,
  repoId,
  worktreeId,
  linkedPRNumber: null,
  reason: 'manual' as const
}

function makeRuntimeRepo(): Repo {
  return {
    id: repoId,
    path: repoPath,
    displayName: 'runtime',
    badgeColor: 'blue',
    addedAt: 1,
    kind: 'git',
    executionHostId: 'runtime:env-1',
    gitRemoteIdentity: {
      canonicalKey: 'github.com/owner/repo',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/owner/repo.git'
    }
  }
}

function seedRuntimeRepo(store: ReturnType<typeof createTestStore>): void {
  const state: Partial<AppState> = {
    repos: [makeRuntimeRepo()],
    worktreesByRepo: {
      [repoId]: [
        makePRRefreshWorktree({
          id: worktreeId,
          repoId,
          path: '/worktrees/wt-runtime',
          displayName: 'runtime',
          branch
        })
      ]
    }
  }
  store.setState(state)
}

function queueRuntimeResult(result: unknown): void {
  runtimeEnvironmentCall.mockResolvedValueOnce({
    id: `rpc-${runtimeEnvironmentCall.mock.calls.length + 1}`,
    ok: true,
    result,
    _meta: { runtimeId: 'remote-runtime' }
  })
}

describe('retractStalePRRefreshError', () => {
  it('drops an error older than the read, and keeps one newer than it', () => {
    const store = createTestStore()
    store.setState({
      prRefreshStates: {
        stale: { status: 'error', reason: 'swr', updatedAt: 1_000, message: 'boom' },
        newer: { status: 'error', reason: 'swr', updatedAt: 3_000, message: 'boom' }
      }
    })

    store.getState().retractStalePRRefreshError('stale', 2_000)
    store.getState().retractStalePRRefreshError('newer', 2_000)

    expect(store.getState().prRefreshStates.stale).toBeUndefined()
    expect(store.getState().prRefreshStates.newer).toBeDefined()
  })

  it('does not notify subscribers when it has nothing to retract', () => {
    const store = createTestStore()
    store.setState({
      prRefreshStates: { newer: { status: 'error', reason: 'swr', updatedAt: 3_000, message: 'x' } }
    })
    const subscriber = vi.fn()
    const unsubscribe = store.subscribe(subscriber)

    store.getState().retractStalePRRefreshError('newer', 2_000)

    expect(subscriber).not.toHaveBeenCalled()
    unsubscribe()
  })
})

describe('Checks panel refresh error for a runtime-owned repo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('retracts the error banner once a later lookup succeeds', async () => {
    const store = createTestStore()
    seedRuntimeRepo(store)
    queueRuntimeResult({
      kind: 'upstream-error',
      errorType: 'network',
      message: 'no route',
      fetchedAt: 1
    })

    await store.getState().fetchPRForBranch(repoPath, branch, refreshOptions)

    const recordedStates = store.getState().prRefreshStates
    const [cacheKey] = Object.keys(recordedStates)
    expect(recordedStates[cacheKey]).toMatchObject({ status: 'error', errorType: 'network' })
    // No coordinator broadcast reaches a runtime-owned repo, so nothing else can retract this.
    expect(mockApi.gh.refreshPRNow).not.toHaveBeenCalled()

    queueRuntimeResult(makePR({ number: 12, title: 'Recovered PR', checksStatus: 'success' }))

    await store.getState().fetchPRForBranch(repoPath, branch, refreshOptions)

    expect(store.getState().prCache[cacheKey]?.data).toMatchObject({ number: 12 })
    expect(store.getState().prRefreshStates[cacheKey]).toBeUndefined()
  })

  it('retracts the error even when the outcome leaves both caches untouched', async () => {
    // Why epoch 0: it pins that a request started at timestamp 0 still retracts, not just after it.
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const store = createTestStore()
    seedRuntimeRepo(store)
    queueRuntimeResult({
      kind: 'upstream-error',
      errorType: 'network',
      message: 'no route',
      fetchedAt: 0
    })

    await store.getState().fetchPRForBranch(repoPath, branch, refreshOptions)

    const [cacheKey] = Object.keys(store.getState().prRefreshStates)
    const mergedPR = makePR({ number: 12, state: 'merged', checksStatus: 'success' })
    store.setState({ prCache: { [cacheKey]: { data: mergedPR, fetchedAt: 0 } } })

    queueRuntimeResult({ kind: 'no-pr', fetchedAt: 0 })

    await store.getState().fetchPRForBranch(repoPath, branch, refreshOptions)

    expect(store.getState().prCache[cacheKey]?.data).toMatchObject({ number: 12, state: 'merged' })
    expect(store.getState().prRefreshStates[cacheKey]).toBeUndefined()
  })
})
