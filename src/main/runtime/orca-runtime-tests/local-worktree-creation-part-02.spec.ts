import * as gitExecFile from '../../git/command-runner/git-exec-file'
import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { addWorktree } from '../../git/worktrees/creation/worktree-add'
import {
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock,
  getPRForBranchMock
} from '../orca-runtime-test-mocks/setup.spec'
import { getBranchConflictKindStrict, getBranchConflictKind } from '../../git/repo-branch-conflict'
import { listWorktrees } from '../../git/worktrees/catalog/worktree-scan-cache'
import { TEST_REPO_PATH, store } from './orca-runtime-test-fixtures.spec'
import { getLocalWorktreeScanGeneration } from '../../workspaces/catalog/local-worktree-scan-generation'

describe('OrcaRuntimeService', () => {
  it('bumps the scan generation before the first step after git worktree add', async () => {
    // Bump generation before post-add awaits so clients can reject earlier listings that omit the new worktree.
    const witness: { duringAdd?: number; afterAdd?: number } = {}
    // Generated-name retirement is the first await after add, exposing the generation race.
    const addRetiredWorktreeName = vi.fn(() => {
      if (witness.duringAdd !== undefined && witness.afterAdd === undefined) {
        witness.afterAdd = getLocalWorktreeScanGeneration('repo-1')
      }
    })
    const runtime = new OrcaRuntimeService({ ...store, addRetiredWorktreeName })
    const createdWorktree = {
      path: '/tmp/workspaces/nautilus',
      head: 'abc123',
      branch: 'refs/heads/nautilus',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(addWorktree).mockImplementationOnce(async () => {
      witness.duringAdd = getLocalWorktreeScanGeneration('repo-1')
      return {}
    })
    vi.mocked(listWorktrees).mockResolvedValue([createdWorktree])

    await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'nautilus',
      nameWasGenerated: true
    })

    expect(addRetiredWorktreeName).toHaveBeenCalledWith('repo-1', 'nautilus')
    expect(witness.afterAdd).toBeGreaterThan(witness.duringAdd ?? Infinity)
  })
  it('recreates a copied workspace fork remote before the runtime host resolves its base', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/fix-title',
      head: 'abc123',
      branch: 'refs/heads/feature/fix',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(getBranchConflictKind).mockResolvedValue(null)
    vi.mocked(listWorktrees).mockResolvedValueOnce([createdWorktree])
    const gitSpy = vi.spyOn(gitExecFile, 'gitExecFileAsync').mockResolvedValue({
      stdout: '',
      stderr: ''
    })

    try {
      await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'fix-title',
        baseBranch: 'fork/feature/fix',
        branchNameOverride: 'feature/fix',
        exactBranchName: true,
        pushTarget: {
          remoteName: 'fork',
          branchName: 'feature/fix',
          remoteUrl: 'git@github.com:alice/orca.git',
          remoteCreated: true
        }
      })

      // Why: this host has never seen that remote, so the copy's base cannot exist until it is added
      // and the branch fetched from it.
      expect(gitSpy).toHaveBeenCalledWith(
        [
          'remote',
          'add',
          '-t',
          'feature/fix',
          '--no-tags',
          'fork',
          'git@github.com:alice/orca.git'
        ],
        expect.objectContaining({ cwd: TEST_REPO_PATH })
      )
      expect(gitSpy).toHaveBeenCalledWith(
        ['fetch', 'fork', '+refs/heads/feature/fix*:refs/remotes/fork/feature/fix*'],
        expect.objectContaining({ cwd: TEST_REPO_PATH })
      )
      expect(gitSpy).toHaveBeenCalledWith(
        ['branch', '--set-upstream-to', 'fork/feature/fix', 'feature/fix'],
        expect.objectContaining({ cwd: createdWorktree.path })
      )
      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'feature/fix',
        'fork/feature/fix',
        false,
        false,
        {}
      )
      const remoteAddIndex = gitSpy.mock.calls.findIndex(
        (call) => call[0][0] === 'remote' && call[0][1] === 'add'
      )
      expect(remoteAddIndex).toBeGreaterThanOrEqual(0)
      // Why the order: the base ref can only exist after the remote is added and fetched.
      expect(gitSpy.mock.invocationCallOrder[remoteAddIndex]).toBeLessThan(
        vi.mocked(addWorktree).mock.invocationCallOrder[0] ?? 0
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('leaves a non-copy create alone even when it carries a fork remote URL', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/fix-title',
      head: 'abc123',
      branch: 'refs/heads/fix-title',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(getBranchConflictKind).mockResolvedValue(null)
    vi.mocked(listWorktrees).mockResolvedValueOnce([createdWorktree])
    const gitSpy = vi.spyOn(gitExecFile, 'gitExecFileAsync').mockResolvedValue({
      stdout: '',
      stderr: ''
    })

    try {
      await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'fix-title',
        // The same base a copy would use, so only the exact-branch flag separates the two.
        baseBranch: 'fork/feature/fix',
        pushTarget: {
          remoteName: 'fork',
          branchName: 'feature/fix',
          remoteUrl: 'git@github.com:alice/orca.git'
        }
      })

      // Why: only a copy keeps a branch it must fetch first; every other create defers the remote
      // to the first push/pull/fetch, so nothing may add it before the checkout exists.
      expect(addWorktree).toHaveBeenCalled()
      const addWorktreeOrder = vi.mocked(addWorktree).mock.invocationCallOrder[0] ?? 0
      const earlyRemoteAdd = gitSpy.mock.calls.findIndex(
        (call, index) =>
          call[0][0] === 'remote' &&
          call[0][1] === 'add' &&
          (gitSpy.mock.invocationCallOrder[index] ?? Infinity) < addWorktreeOrder
      )
      expect(earlyRemoteAdd).toBe(-1)
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('refuses an exact-name create even when a selected PR matches the remote branch', async () => {
    const runtime = new OrcaRuntimeService(store)
    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/fix-title')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/fix-title')
    vi.mocked(addWorktree).mockClear()
    vi.mocked(getBranchConflictKindStrict).mockResolvedValue('remote')
    getPRForBranchMock.mockResolvedValue({
      number: 42,
      title: 'Selected PR',
      state: 'open',
      url: 'https://example.com/pr/42',
      checksStatus: 'success',
      updatedAt: '2026-05-21T00:00:00Z',
      mergeable: 'UNKNOWN'
    })
    const gitSpy = vi.spyOn(gitExecFile, 'gitExecFileAsync').mockResolvedValue({
      stdout: '',
      stderr: ''
    })

    try {
      await expect(
        runtime.createManagedWorktree({
          repoSelector: 'id:repo-1',
          name: 'fix-title',
          baseBranch: 'abc123',
          branchNameOverride: 'feature/fix',
          branchIntent: 'create-exact',
          linkedPR: 42,
          pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
        })
      ).rejects.toMatchObject({ code: 'worktree_create_exact_name_taken' })
      expect(addWorktree).not.toHaveBeenCalled()
    } finally {
      vi.mocked(getBranchConflictKindStrict).mockResolvedValue(null)
      getPRForBranchMock.mockReset()
      gitSpy.mockRestore()
    }
  })
})
