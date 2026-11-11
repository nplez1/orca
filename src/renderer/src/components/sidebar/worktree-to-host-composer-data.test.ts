import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  buildWorktreeToHostComposerData,
  getAddWorktreeToAnotherHostAvailability
} from './worktree-to-host-composer-data'

const localRepo: Repo = {
  id: 'local-repo',
  path: '/Users/alice/orca',
  displayName: 'Orca',
  badgeColor: '#737373',
  addedAt: 100,
  kind: 'git'
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'local-repo::/Users/alice/orca-worktrees/fix-login',
    repoId: 'local-repo',
    path: '/Users/alice/orca-worktrees/fix-login',
    head: 'abc1234',
    branch: 'refs/heads/feature/fix-login',
    isBare: false,
    isMainWorktree: false,
    displayName: 'Fix the login redirect',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

describe('add workspace to another host', () => {
  it('hands the composer the implied project, name and branch, and a remote start point', () => {
    const data = buildWorktreeToHostComposerData({
      worktree: makeWorktree(),
      repo: localRepo,
      projectId: 'github:acme/app'
    })

    expect(data).toEqual({
      initialWorkspaceTarget: { projectId: 'github:acme/app' },
      initialRepoId: 'local-repo',
      lockedWorkspaceBranch: 'feature/fix-login',
      // Why the flag: a clone of this workspace is that workspace only when it is the checkout itself.
      lockedWorkspaceIsPrimary: false,
      // Why the remote copy: the target host usually has this branch only as a remote-tracking ref.
      initialBaseBranch: 'origin/feature/fix-login',
      lockedWorkspaceSourceHostId: 'local',
      telemetrySource: 'sidebar'
    })
  })

  it('marks a copy of the primary checkout as the checkout itself', () => {
    const data = buildWorktreeToHostComposerData({
      worktree: makeWorktree({ isMainWorktree: true }),
      repo: localRepo,
      projectId: 'github:acme/app'
    })

    expect(data.lockedWorkspaceIsPrimary).toBe(true)
  })

  it('starts from the remote the workspace publishes to', () => {
    const data = buildWorktreeToHostComposerData({
      worktree: makeWorktree({
        pushTarget: { remoteName: 'fork', branchName: 'feature/fix-login' }
      }),
      repo: localRepo,
      projectId: null
    })

    expect(data.initialBaseBranch).toBe('fork/feature/fix-login')
  })

  it('carries the fork remote URL so the target host can recreate that remote', () => {
    const data = buildWorktreeToHostComposerData({
      worktree: makeWorktree({
        pushTarget: {
          remoteName: 'fork',
          branchName: 'feature/fix-login',
          remoteUrl: 'git@github.com:alice/orca.git',
          remoteCreated: true
        }
      }),
      repo: localRepo,
      projectId: 'github:acme/app'
    })

    // Why the URL and not remoteCreated: ownership of the remote on the source host says nothing
    // about the target, which has to add and fetch the remote itself.
    expect(data.lockedWorkspacePushTarget).toEqual({
      remoteName: 'fork',
      branchName: 'feature/fix-login',
      remoteUrl: 'git@github.com:alice/orca.git'
    })
    expect(data.initialBaseBranch).toBe('fork/feature/fix-login')
  })

  it('keeps the repo row as a fallback when the workspace never got a project id', () => {
    const data = buildWorktreeToHostComposerData({
      worktree: makeWorktree(),
      repo: localRepo,
      projectId: null
    })

    expect(data.initialWorkspaceTarget).toBeUndefined()
    expect(data.initialRepoId).toBe('local-repo')
  })

  it('takes the source host from the row, then the repo, and records a paired runtime owner', () => {
    expect(
      buildWorktreeToHostComposerData({
        worktree: makeWorktree({ hostId: 'ssh:build-box' }),
        repo: localRepo,
        projectId: null
      }).lockedWorkspaceSourceHostId
    ).toBe('ssh:build-box')

    // Why: rows discovered before host stamping fall back to the repo's transport.
    const inherited = buildWorktreeToHostComposerData({
      worktree: makeWorktree({ runtimeOwnerEnvironmentId: 'env-b' }),
      repo: { ...localRepo, executionHostId: 'runtime:env-b' },
      projectId: null
    })
    expect(inherited.lockedWorkspaceSourceHostId).toBe('runtime:env-b')
    expect(inherited.lockedWorkspaceSourceRuntimeOwnerEnvironmentId).toBe('env-b')
  })

  it('offers the copy for every workspace on a branch, including the primary checkout', () => {
    expect(
      getAddWorktreeToAnotherHostAvailability({
        worktree: makeWorktree(),
        repo: localRepo,
        projectId: 'github:acme/app'
      })
    ).toEqual({ kind: 'available' })
    // Why: the branch being copied decides whether the copy lands, not whether the row is the
    // repo's primary checkout — a primary checkout on a feature branch copies fine.
    expect(
      getAddWorktreeToAnotherHostAvailability({
        worktree: makeWorktree({ isMainWorktree: true, branch: 'refs/heads/feature/fix-login' }),
        repo: localRepo,
        projectId: 'github:acme/app'
      })
    ).toEqual({ kind: 'available' })
  })

  it('offers the copy for a fork-PR workspace whose remote Orca can recreate', () => {
    expect(
      getAddWorktreeToAnotherHostAvailability({
        worktree: makeWorktree({
          pushTarget: {
            remoteName: 'fork',
            branchName: 'fix-login',
            remoteUrl: 'git@github.com:alice/orca.git',
            remoteCreated: true
          }
        }),
        repo: localRepo,
        projectId: 'github:acme/app'
      })
    ).toEqual({ kind: 'available' })
  })

  it('refuses what no target host could satisfy, and hides a detached HEAD', () => {
    // Why: a folder project has no branch to recreate on another host.
    expect(
      getAddWorktreeToAnotherHostAvailability({
        worktree: makeWorktree(),
        repo: { kind: 'folder' },
        projectId: 'github:acme/app'
      })
    ).toEqual({ kind: 'refused', reason: 'folder-project' })
    // Why: repo:<id> names a project only this host can resolve.
    expect(
      getAddWorktreeToAnotherHostAvailability({
        worktree: makeWorktree(),
        repo: localRepo,
        projectId: 'repo:local-repo'
      })
    ).toEqual({ kind: 'refused', reason: 'project-without-shared-remote' })
    // Why: a legacy row can carry a created remote without the URL needed to recreate it.
    expect(
      getAddWorktreeToAnotherHostAvailability({
        worktree: makeWorktree({
          pushTarget: { remoteName: 'fork', branchName: 'fix-login', remoteCreated: true }
        }),
        repo: localRepo,
        projectId: 'github:acme/app'
      })
    ).toEqual({ kind: 'refused', reason: 'publish-remote-not-recreatable' })
    // Why: a branch only another host's remote holds is equally unreachable there.
    expect(
      getAddWorktreeToAnotherHostAvailability({
        worktree: makeWorktree({
          pushTarget: { remoteName: 'alice', branchName: 'fix-login' }
        }),
        repo: localRepo,
        projectId: 'github:acme/app'
      })
    ).toEqual({ kind: 'refused', reason: 'publish-remote-not-recreatable' })
    // A detached HEAD reaches the row as an empty branch, and has nothing to copy.
    expect(
      getAddWorktreeToAnotherHostAvailability({
        worktree: makeWorktree({ branch: '' }),
        repo: localRepo,
        projectId: 'github:acme/app'
      })
    ).toEqual({ kind: 'hidden' })
    expect(
      getAddWorktreeToAnotherHostAvailability({
        worktree: makeWorktree({ branch: '  ' }),
        repo: localRepo,
        projectId: 'github:acme/app'
      })
    ).toEqual({ kind: 'hidden' })
  })
})
