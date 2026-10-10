import { describe, expect, it, vi } from 'vitest'
import {
  isCheckoutOutsideProjectFolder,
  planPrimaryCheckoutRelocation,
  relocatePrimaryCheckout,
  type RelocationDependencies,
  type RelocationPlan
} from './project-folder-relocation'

const projectFolderSettings = {
  workspaceDir: '/Users/nathanp/orca/workspaces',
  nestWorkspaces: false,
  worktreeLayoutMode: 'project-folder' as const
}

describe('planPrimaryCheckoutRelocation', () => {
  it('plans the move for a checkout sitting outside its container', () => {
    // The live shape: checkout elsewhere, worktrees already in the project folder.
    const decision = planPrimaryCheckoutRelocation({
      repo: {
        path: '/Users/nathanp/Code/homelab',
        displayName: 'homelab',
        worktreeBasePath: '/Users/nathanp/orca/workspaces/homelab'
      },
      settings: projectFolderSettings,
      defaultBranchName: 'main',
      platform: 'darwin'
    })

    expect(decision).toEqual({
      kind: 'ready',
      plan: {
        containerPath: '/Users/nathanp/orca/workspaces/homelab',
        targetPath: '/Users/nathanp/orca/workspaces/homelab/main',
        defaultBranchName: 'main'
      }
    })
  })

  it('skips a checkout already inside its container', () => {
    const decision = planPrimaryCheckoutRelocation({
      repo: { path: '/Users/nathanp/Code/orca/main', displayName: 'orca', worktreeBasePath: '..' },
      settings: projectFolderSettings,
      defaultBranchName: 'main',
      platform: 'darwin'
    })

    expect(decision).toEqual({ kind: 'skipped', reason: 'already-in-container' })
  })

  it('names the checkout folder for the branch it will hold', () => {
    const decision = planPrimaryCheckoutRelocation({
      repo: { path: '/Code/homelab', displayName: 'homelab', worktreeBasePath: '/ws/homelab' },
      settings: projectFolderSettings,
      defaultBranchName: 'develop',
      platform: 'darwin'
    })

    expect(decision.kind === 'ready' && decision.plan.targetPath).toBe('/ws/homelab/develop')
  })

  it('skips when the layout has no container to move it into', () => {
    expect(
      planPrimaryCheckoutRelocation({
        repo: { path: '/Code/homelab', displayName: 'homelab' },
        settings: { ...projectFolderSettings, worktreeLayoutMode: 'flat' },
        defaultBranchName: 'main',
        platform: 'darwin'
      })
    ).toEqual({ kind: 'skipped', reason: 'not-project-folder-layout' })
  })

  it('skips a folder repo, which has no primary checkout to move', () => {
    expect(
      planPrimaryCheckoutRelocation({
        repo: { path: '/Code/docs', displayName: 'docs', kind: 'folder' },
        settings: projectFolderSettings,
        defaultBranchName: 'main',
        platform: 'darwin'
      })
    ).toEqual({ kind: 'skipped', reason: 'not-a-git-repo' })
  })

  it("skips a checkout on another host, whose move is that host's decision", () => {
    expect(
      planPrimaryCheckoutRelocation({
        repo: { path: '/srv/app', displayName: 'app' },
        executionHostId: 'ssh:target-1',
        settings: projectFolderSettings,
        defaultBranchName: 'main',
        platform: 'darwin'
      })
    ).toEqual({ kind: 'skipped', reason: 'remote-host' })
  })

  it('skips Windows, where the OS locks a directory that is a process cwd', () => {
    expect(
      planPrimaryCheckoutRelocation({
        repo: { path: 'C:\\work\\app', displayName: 'app' },
        settings: projectFolderSettings,
        defaultBranchName: 'main',
        platform: 'win32'
      })
    ).toEqual({ kind: 'skipped', reason: 'windows' })
  })

  it('skips when the default branch cannot be resolved', () => {
    // Why refuse rather than assume `main`: the folder name is written once, so a guess would
    // leave the checkout in a folder that does not match the branch it holds.
    expect(
      planPrimaryCheckoutRelocation({
        repo: { path: '/Code/homelab', displayName: 'homelab' },
        settings: projectFolderSettings,
        defaultBranchName: null,
        platform: 'darwin'
      })
    ).toEqual({ kind: 'skipped', reason: 'unknown-default-branch' })
  })
})

describe('isCheckoutOutsideProjectFolder', () => {
  it('detects a checkout outside its folder without resolving a branch', () => {
    // Why no branch: this is what a listing can afford per repo, and the branch only names the
    // destination folder.
    expect(
      isCheckoutOutsideProjectFolder({
        repo: { path: '/Code/homelab', displayName: 'homelab', worktreeBasePath: '/ws/homelab' },
        settings: projectFolderSettings,
        platform: 'darwin'
      })
    ).toBe(true)
  })

  it('is false for a checkout already in its folder', () => {
    expect(
      isCheckoutOutsideProjectFolder({
        repo: { path: '/ws/homelab/main', displayName: 'homelab', worktreeBasePath: '/ws/homelab' },
        settings: projectFolderSettings,
        platform: 'darwin'
      })
    ).toBe(false)
  })

  it('is false when the layout has no container, so nothing could be done about it', () => {
    expect(
      isCheckoutOutsideProjectFolder({
        repo: { path: '/Code/homelab', displayName: 'homelab', worktreeBasePath: '/ws/homelab' },
        settings: { ...projectFolderSettings, worktreeLayoutMode: 'flat' },
        platform: 'darwin'
      })
    ).toBe(false)
  })
})

const plan: RelocationPlan = {
  containerPath: '/ws/homelab',
  targetPath: '/ws/homelab/main',
  defaultBranchName: 'main'
}

function makeDeps(overrides: Partial<RelocationDependencies> = {}): RelocationDependencies {
  return {
    pathExists: vi.fn().mockResolvedValue(false),
    isSameVolume: vi.fn().mockResolvedValue(true),
    hasLiveSessions: vi.fn().mockResolvedValue(false),
    makeDirectory: vi.fn().mockResolvedValue(undefined),
    moveDirectory: vi.fn().mockResolvedValue(undefined),
    repairWorktrees: vi.fn().mockResolvedValue(undefined),
    setRepoPath: vi.fn(),
    migrateWorktreeIdentity: vi.fn(),
    notifyRepoRelocated: vi.fn(),
    ...overrides
  }
}

const repo = { id: 'repo-1', path: '/Code/homelab' }

describe('relocatePrimaryCheckout', () => {
  it('moves the checkout, repairs worktrees, then re-keys and reports', async () => {
    const deps = makeDeps()

    const outcome = await relocatePrimaryCheckout({ repo, plan, deps })

    expect(outcome).toEqual({ kind: 'relocated', from: '/Code/homelab', to: '/ws/homelab/main' })
    expect(deps.makeDirectory).toHaveBeenCalledWith('/ws/homelab')
    expect(deps.moveDirectory).toHaveBeenCalledWith('/Code/homelab', '/ws/homelab/main')
    // Repair before the records: the linked worktrees still point at the old main checkout.
    expect(deps.repairWorktrees).toHaveBeenCalledWith('/ws/homelab/main')
    expect(deps.setRepoPath).toHaveBeenCalledWith('repo-1', '/ws/homelab/main')
    expect(deps.migrateWorktreeIdentity).toHaveBeenCalledWith(
      'repo-1::/Code/homelab',
      'repo-1::/ws/homelab/main'
    )
    expect(deps.notifyRepoRelocated).toHaveBeenCalledWith(
      'repo-1',
      'repo-1::/Code/homelab',
      'repo-1::/ws/homelab/main'
    )
  })

  it.each([
    ['a live session', { hasLiveSessions: vi.fn().mockResolvedValue(true) }, 'live-sessions'],
    ['a taken target', { pathExists: vi.fn().mockResolvedValue(true) }, 'target-exists'],
    ['a cross-volume target', { isSameVolume: vi.fn().mockResolvedValue(false) }, 'cross-volume']
  ])('refuses %s without touching the filesystem', async (_label, overrides, reason) => {
    const deps = makeDeps(overrides)

    const outcome = await relocatePrimaryCheckout({ repo, plan, deps })

    expect(outcome).toEqual({ kind: 'skipped', reason })
    expect(deps.moveDirectory).not.toHaveBeenCalled()
    expect(deps.setRepoPath).not.toHaveBeenCalled()
    expect(deps.migrateWorktreeIdentity).not.toHaveBeenCalled()
  })

  it('moves the checkout back when repair fails, and writes no records', async () => {
    const failure = new Error('repair failed')
    const deps = makeDeps({ repairWorktrees: vi.fn().mockRejectedValue(failure) })

    await expect(relocatePrimaryCheckout({ repo, plan, deps })).rejects.toThrow('repair failed')

    // Why: a checkout whose records still point at the old path is worse than an unmoved one.
    expect(deps.moveDirectory).toHaveBeenLastCalledWith('/ws/homelab/main', '/Code/homelab')
    expect(deps.setRepoPath).not.toHaveBeenCalled()
    expect(deps.migrateWorktreeIdentity).not.toHaveBeenCalled()
    expect(deps.notifyRepoRelocated).not.toHaveBeenCalled()
  })
})
