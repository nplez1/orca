/**
 * Relocation against a real git repository and a real filesystem.
 *
 * The planner and executor were unit-tested with fakes, which cannot show that the risky half —
 * `rename` plus `git worktree repair` — actually re-establishes linked worktrees. This does: the
 * fixture is the shape the feature exists for, a checkout outside its project folder with the
 * worktrees already inside it.
 */
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gitExecFileAsync } from './git/runner'
import { runProcessSync } from '../shared/child-process/run-process'
import { getRepoMainWorktreeId } from '../shared/worktree/id'
import {
  planPrimaryCheckoutRelocation,
  relocatePrimaryCheckout,
  type RelocationDependencies
} from './project-folder-relocation'

let root: string
let checkout: string
let container: string

function git(cwd: string, ...args: string[]): void {
  const result = runProcessSync({
    program: 'git',
    args: ['-c', 'user.name=Orca', '-c', 'user.email=orca@example.com', ...args],
    cwd
  })
  expect(result.code, result.stderr).toBe(0)
}

/** The production dependencies, with the real filesystem and the real git runner. */
function realDeps(overrides: Partial<RelocationDependencies> = {}): RelocationDependencies {
  return {
    pathExists: async (path) => existsSync(path),
    isSameVolume: async (from, to) => (await stat(from)).dev === (await stat(dirname(to))).dev,
    hasLiveSessions: async () => false,
    makeDirectory: async (path) => {
      await mkdir(path, { recursive: true })
    },
    moveDirectory: async (from, to) => {
      await rename(from, to)
    },
    repairWorktrees: async (movedRepoPath) => {
      await gitExecFileAsync(['worktree', 'repair'], { cwd: movedRepoPath })
    },
    setRepoPath: vi.fn(),
    migrateWorktreeIdentity: vi.fn(),
    notifyRepoRelocated: vi.fn(),
    ...overrides
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-relocate-'))
  checkout = join(root, 'Code', 'homelab')
  container = join(root, 'orca', 'workspaces', 'homelab')
  await mkdir(checkout, { recursive: true })
  git(checkout, 'init', '-q')
  git(checkout, '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init')
  // The worktrees already sit in the container, which is what makes this project-folder shaped.
  await mkdir(container, { recursive: true })
  git(checkout, 'worktree', 'add', '-q', join(container, 'wip-one'))
  git(checkout, 'worktree', 'add', '-q', join(container, 'wip-two'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const settings = () => ({
  workspaceDir: join(root, 'orca', 'workspaces'),
  nestWorkspaces: false,
  worktreeLayoutMode: 'project-folder' as const
})

const repo = () => ({
  id: 'repo-homelab',
  path: checkout,
  displayName: 'homelab',
  worktreeBasePath: container
})

describe('relocating a primary checkout with linked worktrees', () => {
  it('moves it into the container and leaves every worktree usable', async () => {
    const decision = planPrimaryCheckoutRelocation({
      repo: repo(),
      settings: settings(),
      defaultBranchName: 'main',
      platform: 'darwin'
    })
    if (decision.kind !== 'ready') {
      throw new Error(`expected a ready plan, got ${decision.reason}`)
    }
    expect(decision.plan.targetPath).toBe(join(container, 'main'))

    const deps = realDeps()
    const outcome = await relocatePrimaryCheckout({
      repo: { id: 'repo-homelab', path: checkout },
      plan: decision.plan,
      deps
    })

    const target = join(container, 'main')
    expect(outcome).toEqual({ kind: 'relocated', from: checkout, to: target })
    expect(existsSync(checkout)).toBe(false)
    expect(existsSync(target)).toBe(true)

    // The proof that `git worktree repair` did its job: both linked worktrees still resolve.
    const listed = runProcessSync({ program: 'git', args: ['worktree', 'list'], cwd: target })
    expect(listed.code, listed.stderr).toBe(0)
    expect(listed.stdout).toContain(join(container, 'wip-one'))
    expect(listed.stdout).toContain(join(container, 'wip-two'))
    for (const worktree of [join(container, 'wip-one'), join(container, 'wip-two')]) {
      const status = runProcessSync({
        program: 'git',
        args: ['status', '--porcelain'],
        cwd: worktree
      })
      expect(status.code, status.stderr).toBe(0)
      expect(status.stdout).toContain('')
    }

    // Records: the path write, then the id re-key, then the notification.
    expect(deps.setRepoPath).toHaveBeenCalledWith('repo-homelab', target)
    expect(deps.migrateWorktreeIdentity).toHaveBeenCalledWith(
      getRepoMainWorktreeId({ id: 'repo-homelab', path: checkout }),
      getRepoMainWorktreeId({ id: 'repo-homelab', path: target })
    )
    expect(deps.notifyRepoRelocated).toHaveBeenCalledOnce()
  })

  it('breaks linked worktrees when the gitdir links are not repaired', async () => {
    // Why this asserts a failure: it is the reason step 3 exists. A bare rename leaves each linked
    // worktree pointing at a gitdir under the old path, so the move alone is never sufficient.
    await rename(checkout, join(container, 'main'))

    const status = runProcessSync({
      program: 'git',
      args: ['status', '--porcelain'],
      cwd: join(container, 'wip-one')
    })
    expect(status.code).not.toBe(0)

    const repaired = runProcessSync({
      program: 'git',
      args: ['worktree', 'repair'],
      cwd: join(container, 'main')
    })
    expect(repaired.code, repaired.stderr).toBe(0)
    const afterRepair = runProcessSync({
      program: 'git',
      args: ['status', '--porcelain'],
      cwd: join(container, 'wip-one')
    })
    expect(afterRepair.code, afterRepair.stderr).toBe(0)
  })

  it('refuses to move anything while a terminal is attached', async () => {
    const plan = {
      containerPath: container,
      targetPath: join(container, 'main'),
      defaultBranchName: 'main'
    }
    const deps = realDeps({ hasLiveSessions: async () => true })

    const outcome = await relocatePrimaryCheckout({
      repo: { id: 'repo-homelab', path: checkout },
      plan,
      deps
    })

    expect(outcome).toEqual({ kind: 'skipped', reason: 'live-sessions' })
    expect(existsSync(checkout)).toBe(true)
    expect(existsSync(join(container, 'main'))).toBe(false)
    expect(deps.setRepoPath).not.toHaveBeenCalled()
  })
})
