import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  buildWorktreeToHostComposerData,
  canAddWorktreeToAnotherHost
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
      // Why the remote copy: the target host usually has this branch only as a remote-tracking ref.
      initialBaseBranch: 'origin/feature/fix-login',
      lockedWorkspaceSourceHostId: 'local',
      telemetrySource: 'sidebar'
    })
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

  it('has nothing to copy without a branch or outside a git project', () => {
    expect(canAddWorktreeToAnotherHost({ worktree: makeWorktree(), repo: localRepo })).toBe(true)
    expect(
      canAddWorktreeToAnotherHost({ worktree: makeWorktree({ branch: '  ' }), repo: localRepo })
    ).toBe(false)
    // Why: folder projects have no Available Hosts section for the copy to land in.
    expect(
      canAddWorktreeToAnotherHost({ worktree: makeWorktree(), repo: { kind: 'folder' } })
    ).toBe(false)
    // The target host's own primary checkout already holds the default branch.
    expect(
      canAddWorktreeToAnotherHost({
        worktree: makeWorktree({ isMainWorktree: true }),
        repo: localRepo
      })
    ).toBe(false)
    // A fork-PR head ref only exists on the remote Orca added on this host.
    expect(
      canAddWorktreeToAnotherHost({
        worktree: makeWorktree({
          pushTarget: { remoteName: 'fork', branchName: 'fix-login', remoteCreated: true }
        }),
        repo: localRepo
      })
    ).toBe(false)
    // A detached HEAD reaches the row as an empty branch.
    expect(
      canAddWorktreeToAnotherHost({ worktree: makeWorktree({ branch: '' }), repo: localRepo })
    ).toBe(false)
  })
})
