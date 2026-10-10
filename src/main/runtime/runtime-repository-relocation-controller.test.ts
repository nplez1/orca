/**
 * The relocation controller's job is wiring and reporting, not the move itself: the mechanics are
 * covered against real git in `project-folder-relocation.integration.test.ts`. What is pinned here
 * is the decision it hands the caller, the dry run that must not move anything, and the host guard.
 *
 * The fixture is real because the branch name is resolved through git, which is deliberate: the
 * folder is named after the branch, so a path that cannot answer must not get a guessed name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runProcessSync } from '../../shared/child-process/run-process'
import type { Repo } from '../../shared/repo-types'
import { RuntimeRepositoryRelocationController } from './runtime-repository-relocation-controller'

vi.mock('../ipc/filesystem-auth', () => ({ invalidateAuthorizedRootsCache: vi.fn() }))
vi.mock('../worktree-root-preparation', () => ({ prepareLocalWorktreeRootForRepo: vi.fn() }))

let root: string

function git(cwd: string, ...args: string[]): void {
  const result = runProcessSync({
    program: 'git',
    args: ['-c', 'user.name=Orca', '-c', 'user.email=orca@example.com', ...args],
    cwd
  })
  expect(result.code, result.stderr).toBe(0)
}

/** A real git repository whose default branch is `main` on every git version. */
async function makeCheckout(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  git(path, 'init', '-q')
  git(path, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  git(path, '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init')
}

function makeController(options: {
  repo: { id: string; path: string; displayName: string; worktreeBasePath?: string }
  hasRelocationStore?: boolean
  hasLiveSessions?: boolean
  truncateList?: boolean
}): RuntimeRepositoryRelocationController {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the controller reads only id, path and displayName off this row.
  const repo = { badgeColor: '#000000', addedAt: 1, ...options.repo } as Repo
  const store = {
    getSettings: () => ({
      workspaceDir: join(root, 'ws'),
      nestWorkspaces: false,
      worktreeLayoutMode: 'project-folder' as const
    }),
    getRepo: () => repo,
    getRepos: () => [repo],
    ...(options.hasRelocationStore === false
      ? {}
      : { relocateRepoPath: vi.fn(() => repo), migrateWorktreeIdentity: vi.fn() })
  }
  return new RuntimeRepositoryRelocationController({
    getStore: () => store,
    resolveRepo: async () => repo,
    getWorktreePs: async (_limit: number) => ({
      truncated: options.truncateList ?? false,
      worktrees: [
        {
          repoId: 'r1',
          hasAttachedPty: options.hasLiveSessions ?? false,
          liveTerminalCount: 0,
          unverifiableTerminalCount: 0
        }
      ]
    }),
    notifyRepoRelocated: vi.fn(),
    invalidateResolvedWorktrees: vi.fn(),
    notifyReposChanged: vi.fn()
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-relocate-controller-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('RuntimeRepositoryRelocationController', () => {
  it('reports a ready decision on a dry run without moving anything', async () => {
    const checkout = join(root, 'Code', 'homelab')
    const container = join(root, 'ws', 'homelab')
    await makeCheckout(checkout)
    const controller = makeController({
      repo: { id: 'r1', path: checkout, displayName: 'homelab', worktreeBasePath: container }
    })

    const result = await controller.relocate('name:homelab', { dryRun: true })

    expect(result).toEqual({
      repoId: 'r1',
      decision: 'ready',
      plan: {
        containerPath: container,
        targetPath: join(container, 'main'),
        defaultBranchName: 'main'
      }
    })
    // No outcome on a dry run: it reports a decision, it does not act on one.
    expect(result.outcome).toBeUndefined()
    // Nothing moved, so the checkout is still where it was.
    expect(
      runProcessSync({ program: 'git', args: ['rev-parse', '--git-dir'], cwd: checkout }).code
    ).toBe(0)
  })

  it('reports a checkout that needs no move as a decision rather than an error', async () => {
    const container = join(root, 'ws', 'orca')
    await makeCheckout(join(container, 'main'))
    const controller = makeController({
      repo: {
        id: 'r1',
        path: join(container, 'main'),
        displayName: 'orca',
        worktreeBasePath: container
      }
    })

    await expect(controller.relocate('name:orca', { dryRun: true })).resolves.toEqual({
      repoId: 'r1',
      decision: 'already-in-container'
    })
  })

  it('refuses while a workspace still has a terminal attached', async () => {
    const checkout = join(root, 'Code', 'homelab')
    await makeCheckout(checkout)
    const controller = makeController({
      repo: {
        id: 'r1',
        path: checkout,
        displayName: 'homelab',
        worktreeBasePath: join(root, 'ws', 'homelab')
      },
      hasLiveSessions: true
    })

    const result = await controller.relocate('name:homelab')

    expect(result.decision).toBe('ready')
    expect(result.outcome).toEqual({ kind: 'live-sessions' })
  })

  it('treats an unverifiable terminal as live rather than exited', async () => {
    const checkout = join(root, 'Code', 'homelab')
    await makeCheckout(checkout)
    const controller = makeController({
      repo: {
        id: 'r1',
        path: checkout,
        displayName: 'homelab',
        worktreeBasePath: join(root, 'ws', 'homelab')
      },
      truncateList: true
    })

    const result = await controller.relocate('name:homelab')

    // A truncated listing cannot prove the absence of a session, so it is not an answer.
    expect(result.outcome).toEqual({ kind: 'live-sessions' })
  })

  it('lists the repo as needing relocation without asking about its branch', async () => {
    const checkout = join(root, 'Code', 'homelab')
    await mkdir(checkout, { recursive: true })
    // No git repo at all, and it still detects: the rule is path math, so a listing can afford it.
    const controller = makeController({
      repo: {
        id: 'r1',
        path: checkout,
        displayName: 'homelab',
        worktreeBasePath: join(root, 'ws', 'homelab')
      }
    })

    expect(controller.findReposRequiringRelocation()).toEqual(['r1'])
  })

  it('lists nothing for a checkout already in its folder', async () => {
    const container = join(root, 'ws', 'orca')
    await mkdir(join(container, 'main'), { recursive: true })
    const controller = makeController({
      repo: {
        id: 'r1',
        path: join(container, 'main'),
        displayName: 'orca',
        worktreeBasePath: container
      }
    })

    expect(controller.findReposRequiringRelocation()).toEqual([])
  })

  it('refuses on a host that cannot relocate records', async () => {
    const controller = makeController({
      repo: { id: 'r1', path: join(root, 'Code', 'homelab'), displayName: 'homelab' },
      hasRelocationStore: false
    })

    await expect(controller.relocate('name:homelab')).rejects.toThrow('runtime_unavailable')
  })

  it('refuses to name the folder when the checkout cannot name its branch', async () => {
    const notARepo = join(root, 'Code', 'homelab')
    await mkdir(notARepo, { recursive: true })
    const controller = makeController({
      repo: {
        id: 'r1',
        path: notARepo,
        displayName: 'homelab',
        worktreeBasePath: join(root, 'ws', 'homelab')
      }
    })

    await expect(controller.relocate('name:homelab', { dryRun: true })).resolves.toEqual({
      repoId: 'r1',
      decision: 'unknown-default-branch'
    })
  })
})
