import { beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('Checks panel refresh error for a runtime-owned repo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
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
})
