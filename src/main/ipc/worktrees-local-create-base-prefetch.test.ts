import type * as WorktreeScanCacheModule from '../git/worktrees/catalog/worktree-scan-cache'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WorktreeLogic from './worktree-logic'
import {
  addWorktreeMock,
  getBaseRefDefaultMock,
  gitExecFileAsyncMock,
  listWorktreesMock,
  resolveDefaultBaseRefWithLocalGitMock,
  resolveLocalGitUsernameMock
} from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'
import type { WorktreeRuntimeStub } from './worktrees-test-runtime-stub'

vi.mock('../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: (await import('./worktrees-test-module-mocks')).listWorktreesMock,
    listWorktreesSharedStrictAllowingTrueEmpty: (await import('./worktrees-test-module-mocks'))
      .listWorktreesMock,
    listWorktreesSharedStrict: (await import('./worktrees-test-module-mocks')).listWorktreesMock
  }
})

vi.mock('electron', async () =>
  (await import('./worktrees-test-module-mocks')).electronModuleMock()
)
vi.mock('../../shared/git/worktrees/git-worktree-porcelain-parser', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  parseWorktreeList: (await import('./worktrees-test-module-mocks')).parseWorktreeListMock
}))

vi.mock('../git/worktrees/removal/worktree-removal-preflight', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertWorktreeCleanForRemoval: (await import('./worktrees-test-module-mocks'))
    .assertWorktreeCleanForRemovalMock
}))

vi.mock('../git/worktrees/creation/worktree-add', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  addWorktree: (await import('./worktrees-test-module-mocks')).addWorktreeMock
}))

vi.mock('../git/worktrees/creation/worktree-sparse-add', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  addSparseWorktree: (await import('./worktrees-test-module-mocks')).addSparseWorktreeMock
}))

vi.mock('../git/worktrees/removal/worktree-removal', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  removeWorktree: (await import('./worktrees-test-module-mocks')).removeWorktreeMock
}))

vi.mock('../git/worktrees/removal/worktree-branch-removal', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  forceDeleteLocalBranch: (await import('./worktrees-test-module-mocks')).forceDeleteLocalBranchMock
}))
vi.mock('../git/worktrees/catalog/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorktreesStrict: (await import('./worktrees-test-module-mocks')).listWorktreesMock,
  describeCreatedWorktree: (await import('./worktrees-test-module-mocks'))
    .describeCreatedWorktreeMock
}))
const { getWorktreeRunnerMocks } = vi.hoisted(() => {
  function createWorktreeRunnerMocks() {
    return (async () => (await import('./worktrees-test-module-mocks')).gitRunnerModuleMock())()
  }
  let runner: ReturnType<typeof createWorktreeRunnerMocks> | undefined
  return { getWorktreeRunnerMocks: () => (runner ??= createWorktreeRunnerMocks()) }
})

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: (await getWorktreeRunnerMocks()).gitExecFileAsync
}))

vi.mock('../git/command-runner/git-exec-file-sync', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileSync: (await getWorktreeRunnerMocks()).gitExecFileSync
}))
vi.mock('../git/repo', async () =>
  (await import('./worktrees-test-module-mocks')).gitRepoModuleMock()
)

vi.mock('../git/repo-default-base-ref', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBaseRefDefault: (await import('./worktrees-test-module-mocks')).getBaseRefDefaultMock,
  resolveDefaultBaseRefWithLocalGit: (await import('./worktrees-test-module-mocks'))
    .resolveDefaultBaseRefWithLocalGitMock
}))
vi.mock('../git/git-username', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveLocalGitUsername: (await import('./worktrees-test-module-mocks'))
    .resolveLocalGitUsernameMock
}))
vi.mock('../github/client', async () =>
  (await import('./worktrees-test-module-mocks')).githubClientModuleMock()
)
vi.mock('../github/client/lookup/get-pr-for-branch', async () =>
  (await import('./worktrees-test-module-mocks')).githubClientModuleMock()
)
vi.mock('../source-control/hosted-review', async () =>
  (await import('./worktrees-test-module-mocks')).hostedReviewModuleMock()
)
vi.mock('./worktree-symlinks', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeSymlinksModuleMock()
)

vi.mock('../git/worktrees/content-paths/worktree-symlink-detection', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  findExistingWorktreeSymlinkPaths: (await import('./worktrees-test-module-mocks'))
    .findExistingWorktreeSymlinkPathsMock
}))
vi.mock('../workspace-hooks/hooks', async () =>
  (await import('./worktrees-test-module-mocks')).hooksModuleMock()
)
vi.mock('../workspace-hooks/setup-runner-script-text', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupRunnerScriptTextModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../workspace-hooks/worktree-runner-script', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeRunnerScriptModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../workspace-hooks/effective-hook-config', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).effectiveHookConfigModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../workspace-hooks/setup-hook-env-vars', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupHookEnvVarsModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('./worktree-logic', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeLogic>()
  return {
    ...(await import('./worktrees-test-module-mocks')).worktreeLogicModuleMock(actual),
    computeWorkspaceRootAsync: vi.fn(actual.computeWorkspaceRootAsync)
  }
})
vi.mock('../pty/history/terminal-history-deletion', async () =>
  (await import('./worktrees-test-module-mocks')).terminalHistoryDeletionModuleMock()
)
vi.mock('../ports/advertised-url-watcher', async () =>
  (await import('./worktrees-test-module-mocks')).advertisedUrlWatcherModuleMock()
)
vi.mock('../workspaces/cleanup/workspace-cleanup-scan-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupScanSnapshotModuleMock()
)
vi.mock('../workspaces/space-analysis/workspace-space-analysis-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceSpaceAnalysisSnapshotModuleMock()
)
vi.mock('../workspaces/cleanup/workspace-cleanup-removal-snapshot-prune', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupRemovalSnapshotPruneModuleMock()
)
vi.mock('../runtime/workspaces/removal/worktree-teardown', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeTeardownModuleMock()
)
vi.mock('./pty/provider/registry', async () =>
  (await import('./worktrees-test-module-mocks')).ptyRegistryModuleMock()
)
vi.mock('./pty/provider/state-cleanup', async () =>
  (await import('./worktrees-test-module-mocks')).ptyStateCleanupModuleMock()
)

describe('registerWorktreeHandlers', () => {
  let runtimeStub: WorktreeRuntimeStub

  beforeEach(() => {
    runtimeStub = setupWorktreeHandlers()
  })

  it('starts username and base-ref probes concurrently', async () => {
    const events: string[] = []
    let resolveUsername!: (value: string) => void
    let resolveBase!: (value: string | null) => void
    store.getSettings.mockReturnValue({
      branchPrefix: 'git-username',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      workspaceDir: '/workspace'
    })
    resolveLocalGitUsernameMock.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          events.push('username-start')
          resolveUsername = resolve
        })
    )
    resolveDefaultBaseRefWithLocalGitMock.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          events.push('base-start')
          resolveBase = resolve
        })
    )
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/concurrent-probe',
        head: 'created-sha',
        branch: 'jdoe/concurrent-probe',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const creation = handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'concurrent-probe'
    })
    // Concurrent means the base probe starts while the username probe is still unresolved; the
    // copied-push-target gate between them costs a few microtasks.
    await vi.waitFor(() => expect(events).toEqual(['username-start', 'base-start']))
    resolveUsername('jdoe')
    resolveBase('origin/main')
    await expect(creation).resolves.toMatchObject({
      worktree: expect.objectContaining({ branch: 'jdoe/concurrent-probe' })
    })
  })

  it('prefetches the local default create base through the runtime refresh cache', async () => {
    const repo = {
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      worktreeBaseRef: 'origin/master'
    }
    const remoteBase = {
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    }
    store.getRepo.mockReturnValue(repo)
    runtimeStub.resolveRemoteTrackingBase.mockImplementation(async (_repoPath, baseBranch) =>
      baseBranch === 'origin/main' ? remoteBase : null
    )
    runtimeStub.hasRemoteTrackingRef.mockResolvedValue(true)

    await handlers['worktrees:prefetchCreateBase'](null, { repoId: 'repo-1' })

    expect(getBaseRefDefaultMock).toHaveBeenCalledWith('/workspace/repo')
    expect(runtimeStub.resolveRemoteTrackingBase).toHaveBeenCalledWith(
      '/workspace/repo',
      'origin/master'
    )
    expect(runtimeStub.resolveRemoteTrackingBase).toHaveBeenCalledWith(
      '/workspace/repo',
      'origin/main'
    )
    expect(runtimeStub.getOrStartRemoteTrackingBaseRefresh).toHaveBeenCalledWith(
      '/workspace/repo',
      remoteBase
    )
    expect(addWorktreeMock).not.toHaveBeenCalled()
  })

  it('uses the runtime remote fetch cache when prefetching a local branch base', async () => {
    runtimeStub.resolveRemoteTrackingBase.mockResolvedValue(null)

    await handlers['worktrees:prefetchCreateBase'](null, {
      repoId: 'repo-1',
      baseBranch: 'main'
    })

    expect(runtimeStub.fetchRemoteWithCache).toHaveBeenCalledWith('/workspace/repo', 'origin')
    expect(addWorktreeMock).not.toHaveBeenCalled()
  })

  it('prefetches origin for local branch bases containing slashes', async () => {
    runtimeStub.resolveRemoteTrackingBase.mockResolvedValue(null)

    await handlers['worktrees:prefetchCreateBase'](null, {
      repoId: 'repo-1',
      baseBranch: 'Jinwoo-H/vm-improve-2'
    })

    expect(runtimeStub.fetchRemoteWithCache).toHaveBeenCalledWith('/workspace/repo', 'origin')
    expect(runtimeStub.fetchRemoteWithCache).not.toHaveBeenCalledWith('/workspace/repo', 'Jinwoo-H')
    expect(addWorktreeMock).not.toHaveBeenCalled()
  })

  it('does not prefetch the whole remote for an existing commit SHA base', async () => {
    const sha = 'a'.repeat(40)

    await handlers['worktrees:prefetchCreateBase'](null, {
      repoId: 'repo-1',
      baseBranch: sha
    })

    // The warm-up is speculative, so it stays at the default tier; only the create the user is
    // waiting on is promoted.
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`],
      { cwd: '/workspace/repo' }
    )
    expect(runtimeStub.resolveRemoteTrackingBase).not.toHaveBeenCalled()
    expect(runtimeStub.fetchRemoteWithCache).not.toHaveBeenCalled()
    expect(addWorktreeMock).not.toHaveBeenCalled()
  })
})
