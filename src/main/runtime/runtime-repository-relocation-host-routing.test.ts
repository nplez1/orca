/**
 * Which host the relocation plan asks for the default branch — and which plans ask at all.
 *
 * The branch name decides the folder the checkout moves into, so resolving it on the wrong machine
 * names a folder from this machine's checkout — or from nothing at all. A row may name its SSH host
 * only as `ssh:<target>`, which a raw `connectionId` read answers as local, so the read is routed
 * through the resolver rather than the raw field. A row that is not on this machine is refused before
 * any host is asked: there is nothing to move, so there is no folder to name.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { RuntimeRepositoryRelocationController } from './runtime-repository-relocation-controller'

vi.mock('../ipc/filesystem-auth', () => ({ invalidateAuthorizedRootsCache: vi.fn() }))
vi.mock('../worktree-root-preparation', () => ({ prepareLocalWorktreeRootForRepo: vi.fn() }))

const branchReads = vi.hoisted(() => {
  const calls: (string | null | undefined)[][] = []
  return { calls }
})

vi.mock('../source-control/repo-default-branch', () => ({
  getRepoDefaultBranchName: async (repoPath: string, connectionId?: string | null) => {
    branchReads.calls.push([repoPath, connectionId])
    return 'main'
  }
}))

function makeRepo(overrides: Partial<Repo> & Pick<Repo, 'id'>): Repo {
  return {
    path: '/code/example',
    displayName: 'Example',
    badgeColor: '#000000',
    addedAt: 0,
    kind: 'git',
    ...overrides
  }
}

function makeController(repo: Repo): RuntimeRepositoryRelocationController {
  const store = {
    getSettings: () => ({
      workspaceDir: '/ws',
      nestWorkspaces: false,
      worktreeLayoutMode: 'project-folder' as const
    }),
    getRepo: () => repo,
    getRepos: () => [repo],
    relocateRepoPath: vi.fn(() => repo),
    migrateWorktreeIdentity: vi.fn()
  }
  return new RuntimeRepositoryRelocationController({
    getStore: () => store,
    resolveRepo: async () => repo,
    getWorktreePs: async () => ({ truncated: false, worktrees: [] }),
    notifyRepoRelocated: vi.fn(),
    invalidateResolvedWorktrees: vi.fn(),
    notifyReposChanged: vi.fn()
  })
}

beforeEach(() => {
  branchReads.calls = []
})

describe('the host a relocation plan reads the default branch from', () => {
  it('refuses a row that names its host only as ssh:<target> without reading a branch', async () => {
    await expect(
      makeController(makeRepo({ id: 'repo-1', executionHostId: 'ssh:peer' })).relocate('repo-1', {
        dryRun: true
      })
    ).resolves.toEqual({ repoId: 'repo-1', decision: 'remote-host' })

    expect(branchReads.calls).toEqual([])
  })

  it('leaves a local row on this machine', async () => {
    await makeController(makeRepo({ id: 'repo-1' })).relocate('repo-1', { dryRun: true })

    expect(branchReads.calls).toEqual([['/code/example', null]])
  })

  it('refuses a row whose only host evidence is a legacy connectionId', async () => {
    await expect(
      makeController(makeRepo({ id: 'repo-1', connectionId: 'peer' })).relocate('repo-1', {
        dryRun: true
      })
    ).resolves.toEqual({ repoId: 'repo-1', decision: 'remote-host' })

    expect(branchReads.calls).toEqual([])
  })

  it('routes the read through a stale connectionId beside a local host id', async () => {
    await makeController(
      makeRepo({ id: 'repo-1', executionHostId: 'local', connectionId: 'peer' })
    ).relocate('repo-1', { dryRun: true })

    expect(branchReads.calls).toEqual([['/code/example', 'peer']])
  })
})
