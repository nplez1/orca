import { EventEmitter } from 'node:events'
import type * as WorktreeScanCacheModule from '../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../git/worktrees/catalog/worktree-listing'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handlers,
  electronMock,
  store,
  REPO_PATH,
  readFileMock,
  realpathMock,
  searchQuickOpenFilePathsMock,
  resetFilesystemIpcMocks
} from './filesystem-test-harness'

const diskPreconditionMock = vi.hoisted(() => ({ writeLocalTextFileWithDiskPrecondition: vi.fn() }))
vi.mock('../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const { listWorktreesMock } = await import('./filesystem-test-harness')
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktreeGraph: listWorktreesMock,
    listWorktrees: listWorktreesMock
  }
})

vi.mock('../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const { listWorktreesMock } = await import('./filesystem-test-harness')
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: listWorktreesMock
  }
})

vi.mock('./local-disk-write-precondition', () => diskPreconditionMock)
vi.mock('electron', async () => (await import('./filesystem-test-harness')).electronMock)
vi.mock(
  './filesystem-search-file-paths',
  async () => (await import('./filesystem-test-harness')).filePathSearchModuleMock
)
// The distro these UNC fixtures name counts as running, so the boot gate lets the touch through.
vi.mock('../../wsl/discovery/wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readWslDistroRunningState: async () => 'running'
}))
vi.mock('fs/promises', async () => (await import('./filesystem-test-harness')).fsPromisesMock)
vi.mock('node:fs/promises', async () => (await import('./filesystem-test-harness')).fsPromisesMock)
vi.mock(
  '../../wsl/filesystem/wsl-unc-delete',
  async () => (await import('./filesystem-test-harness')).wslUncDeleteMock
)
vi.mock(
  '../../crash-reporting/crash-breadcrumb-store',
  async () => (await import('./filesystem-test-harness')).crashBreadcrumbMock
)
vi.mock('../../git/source-control/commit-changes', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  commitChanges: (await import('./filesystem-test-harness')).commitChangesMock
}))

vi.mock('../../git/source-control/status-read', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getStatus: (await import('./filesystem-test-harness')).getStatusMock
}))

vi.mock('../../git/source-control/git-conflict-operation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  detectConflictOperation: (await import('./filesystem-test-harness')).detectConflictOperationMock,
  abortMerge: (await import('./filesystem-test-harness')).abortMergeMock,
  abortRebase: (await import('./filesystem-test-harness')).abortRebaseMock
}))

vi.mock('../../git/source-control/file-diff', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDiff: (await import('./filesystem-test-harness')).getDiffMock
}))

vi.mock('../../git/source-control/branch-compare', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBranchCompare: (await import('./filesystem-test-harness')).getBranchCompareMock
}))

vi.mock('../../git/source-control/branch-diff', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBranchDiff: (await import('./filesystem-test-harness')).getBranchDiffMock
}))

vi.mock('../../git/source-control/staged-commit-context', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getStagedCommitContext: (await import('./filesystem-test-harness')).getStagedCommitContextMock
}))

vi.mock('../../git/source-control/staging', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stageFile: (await import('./filesystem-test-harness')).stageFileMock,
  bulkStageFiles: (await import('./filesystem-test-harness')).bulkStageFilesMock,
  stageWorktreeChanges: (await import('./filesystem-test-harness')).stageWorktreeChangesMock,
  unstageFile: (await import('./filesystem-test-harness')).unstageFileMock,
  bulkUnstageFiles: (await import('./filesystem-test-harness')).bulkUnstageFilesMock
}))

vi.mock('../../git/source-control/discard-changes', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  bulkDiscardChanges: (await import('./filesystem-test-harness')).bulkDiscardChangesMock,
  discardChanges: (await import('./filesystem-test-harness')).discardChangesMock
}))
vi.mock(
  '../../git/source-control/check-ignored-paths',
  async () => (await import('./filesystem-test-harness')).gitIgnoredPathsMock
)

vi.mock(
  '../../text-generation/commit-message-text-generation',
  async () => (await import('./filesystem-test-harness')).textGenerationModuleMock
)
vi.mock(
  '../../text-generation/pull-request-context',
  async () => (await import('./filesystem-test-harness')).pullRequestContextMock
)
vi.mock(
  '../../source-control/pull-request-template',
  async () => (await import('./filesystem-test-harness')).pullRequestTemplateMock
)
vi.mock(
  '../../source-control/pull-request-linked-issue',
  async () => (await import('./filesystem-test-harness')).pullRequestLinkedIssueMock
)

import { registerFilesystemHandlers } from './filesystem'
import { clearQuickOpenPathInventories } from '../quick-open-path-inventory'
import { hasLocalWorkspacePathIndex } from '../../workspace-path-index/workspace-path-index-runtime'
import { WORKSPACE_PATH_INDEX_DISABLE_ENV } from '../../workspace-path-index/workspace-path-index-feature-switch'
import {
  registerWorktreeRootsForRepo,
  invalidateAuthorizedRootsCache
} from '../worktrees/removal/registered-worktree-roots-cache'

describe('registerFilesystemHandlers', () => {
  beforeEach(() => {
    resetFilesystemIpcMocks()
    clearQuickOpenPathInventories()
    // Reset module-level auth cache so each test starts with a fresh dirty
    // flag — prevents stale worktree data from a prior test's cache rebuild.
    invalidateAuthorizedRootsCache()
  })

  // Handler UNC authorization needs native Windows resolution; shape tests run cross-platform.

  it('rejects readFile when the real path escapes allowed roots', async () => {
    const linkPath = path.resolve('/workspace/repo/link.txt')
    realpathMock.mockImplementation(async (targetPath: string) => {
      if (targetPath === linkPath) {
        return path.resolve('/private/secret.txt')
      }
      return targetPath
    })

    registerFilesystemHandlers(store as never)

    await expect(handlers.get('fs:readFile')!(null, { filePath: linkPath })).rejects.toThrow(
      'Access denied: path resolves outside allowed directories'
    )

    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('rejects readFile when a symlink in a canonical alias worktree escapes the registered root', async () => {
    const aliasWorktreePath = path.resolve('/var/folders/orca/worktrees/feature')
    const canonicalWorktreePath = path.resolve('/private/var/folders/orca/worktrees/feature')
    const aliasLinkPath = path.join(aliasWorktreePath, 'link.txt')
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, aliasWorktreePath])
    realpathMock.mockImplementation(async (targetPath: string) => {
      if (targetPath === aliasWorktreePath) {
        return canonicalWorktreePath
      }
      if (targetPath === aliasLinkPath) {
        return path.resolve('/private/secret.txt')
      }
      return targetPath
    })

    registerFilesystemHandlers(store as never)

    await expect(handlers.get('fs:readFile')!(null, { filePath: aliasLinkPath })).rejects.toThrow(
      'Access denied: path resolves outside allowed directories'
    )

    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('exports instrumentation only from an unpackaged development host', async () => {
    registerFilesystemHandlers(store as never)
    const exportRecords = handlers.get('fs:exportWorkspacePathSearchInstrumentation')
    const diagnosticsSummary = handlers.get('fs:getWorkspacePathSearchDiagnosticsSummary')

    expect(exportRecords?.(null, undefined)).toEqual([])
    expect(diagnosticsSummary?.(null, undefined)).toMatchObject({
      queriesServed: 0,
      strategies: { 'ordered-scan': 0, 'live-scan': 0 },
      admissionRefusals: 0,
      freshnessDowngrades: 0
    })
    electronMock.app.isPackaged = true
    expect(() => exportRecords?.(null, undefined)).toThrow(
      'Workspace path search diagnostics are available only in development.'
    )
    expect(() => diagnosticsSummary?.(null, undefined)).toThrow(
      'Workspace path search diagnostics are available only in development.'
    )
  })

  it('acquires and releases an authorized local path-inventory lease without listing files', async () => {
    registerFilesystemHandlers(store as never)
    const lifecycleListeners: (() => void)[] = []
    const sender = {
      id: 21,
      once: (_event: string, listener: () => void) => lifecycleListeners.push(listener),
      isDestroyed: () => false
    }
    const acquire = handlers.get('fs:acquireQuickOpenPathInventoryLease')
    const release = handlers.get('fs:releaseQuickOpenPathInventoryLease')

    const result = await acquire?.({ sender }, { rootPath: REPO_PATH, includeIgnoredFiles: false })
    expect(result).toMatchObject({ leaseId: expect.any(String) })
    if (
      result === null ||
      typeof result !== 'object' ||
      !('leaseId' in result) ||
      typeof result.leaseId !== 'string'
    ) {
      throw new Error('lease acquisition did not return a lease ID')
    }
    await release?.({ sender }, { leaseId: result.leaseId })
    expect(lifecycleListeners).toHaveLength(2)
  })

  it('uses only complete live scans when the path-index kill switch is set', async () => {
    const previous = process.env[WORKSPACE_PATH_INDEX_DISABLE_ENV]
    process.env[WORKSPACE_PATH_INDEX_DISABLE_ENV] = '1'
    searchQuickOpenFilePathsMock.mockResolvedValue({
      paths: ['src/target.ts'],
      totalCount: 1,
      truncated: false
    })
    try {
      registerFilesystemHandlers(store as never)
      const lease = await handlers.get('fs:acquireQuickOpenPathInventoryLease')?.(
        { sender: { id: 22, isDestroyed: () => false } },
        { rootPath: REPO_PATH, includeIgnoredFiles: true }
      )
      expect(lease).toEqual({ leaseId: null })

      await expect(
        handlers.get('fs:searchFilePaths')!(
          { sender: { id: 22 } },
          { rootPath: REPO_PATH, query: 'target', mode: 'name-filter' }
        )
      ).resolves.toMatchObject({ files: ['src/target.ts'], totalCount: 1, truncated: false })
      expect(searchQuickOpenFilePathsMock).toHaveBeenCalledOnce()
      expect(searchQuickOpenFilePathsMock).toHaveBeenCalledWith(
        REPO_PATH,
        store,
        expect.objectContaining({ mode: 'name-filter' })
      )
      expect(hasLocalWorkspacePathIndex(REPO_PATH)).toBe(false)
      expect(
        handlers.get('fs:getWorkspacePathSearchDiagnosticsSummary')?.(null, undefined)
      ).toMatchObject({
        strategies: { 'live-scan': 1 },
        fallbackReasons: { 'feature-disabled': 1 }
      })

      searchQuickOpenFilePathsMock.mockClear()
      await handlers.get('fs:searchFilePaths')!(null, {
        rootPath: REPO_PATH,
        query: 'trgt',
        mode: 'quick-open'
      })
      expect(searchQuickOpenFilePathsMock).toHaveBeenCalledWith(
        REPO_PATH,
        store,
        expect.objectContaining({ mode: 'quick-open' })
      )
    } finally {
      if (previous === undefined) {
        delete process.env[WORKSPACE_PATH_INDEX_DISABLE_ENV]
      } else {
        process.env[WORKSPACE_PATH_INDEX_DISABLE_ENV] = previous
      }
    }
  })

  it('routes a cold index through a complete live search fallback', async () => {
    searchQuickOpenFilePathsMock.mockResolvedValue({
      paths: ['src/a/b/drover.eve_schema'],
      totalCount: 3,
      truncated: true
    })
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:searchFilePaths')!(
        { sender: Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false }) },
        {
          rootPath: REPO_PATH,
          query: 'drover',
          limit: 5_000,
          mode: 'name-filter',
          requestToken: 'token-1',
          consumerId: 'renderer-window',
          consumerSequence: 7
        }
      )
    ).resolves.toMatchObject({
      files: ['src/a/b/drover.eve_schema'],
      totalCount: 3,
      truncated: true,
      workspacePathSearch: {
        requestIdentity: {
          consumer: { consumerId: 'renderer-window', sequence: 7 }
        },
        rows: [{ relativePath: 'src/a/b/drover.eve_schema' }],
        count: { value: 3, provenance: 'exact-snapshot' },
        state: {
          coverage: 'complete',
          freshness: 'no-known-gap',
          countProvenance: 'exact-snapshot',
          searchComplete: true
        },
        degradationReason: 'uncovered-scope'
      }
    })

    expect(searchQuickOpenFilePathsMock).toHaveBeenCalledOnce()
  })

  it('fs:searchFilePaths rejects malformed renderer consumer identities', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:searchFilePaths')!(
        { sender: Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false }) },
        {
          rootPath: REPO_PATH,
          query: 'target',
          mode: 'name-filter',
          consumerId: 'renderer-window',
          consumerSequence: 1.5
        }
      )
    ).rejects.toThrow('consumer identity is invalid')
  })

  it('fs:searchFilePaths clamps a caller limit to the shared listing ceiling', async () => {
    searchQuickOpenFilePathsMock.mockResolvedValue({ paths: [], totalCount: 0, truncated: false })
    registerFilesystemHandlers(store as never)

    await handlers.get('fs:searchFilePaths')!(null, {
      rootPath: '/home/user/repo',
      query: 'target',
      limit: 10_000_000
    })

    expect(searchQuickOpenFilePathsMock).toHaveBeenCalledWith(
      '/home/user/repo',
      store,
      expect.objectContaining({ limit: 20_001 })
    )
  })
})
