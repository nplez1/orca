// Real-binary coverage for the opt-in remote-branch delete: the mocked-runner suite proves the
// decision matrix, but not that real Git accepts `push --delete <remote> <branch>`, that the
// branch-scoped upstream resolution reads the `branch.<name>.*` config Git actually wrote, or that
// the upstream is still readable at the point removal reads it.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeWorktree } from './worktree'
import { whenWorktreeTrashDeletionsSettled } from '../worktree-trash'

const execFileAsync = promisify(execFile)

let scratchDir = ''
let originPath = ''
let repoPath = ''
let worktreePath = ''

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout
}

async function originHasBranch(branchName: string): Promise<boolean> {
  const { stdout } = await execFileAsync('git', [
    '--git-dir',
    originPath,
    'for-each-ref',
    '--format=%(refname)',
    'refs/heads/'
  ])
  return stdout.split('\n').includes(`refs/heads/${branchName}`)
}

beforeEach(async () => {
  // realpath: macOS hands out /var/... temp paths while Git reports /private/var/..., and Orca
  // matches the worktree it is removing against Git's own list.
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-remote-branch-removal-')))
  originPath = join(scratchDir, 'origin.git')
  repoPath = join(scratchDir, 'repo')
  worktreePath = join(scratchDir, 'feature-wt')
  await mkdir(repoPath, { recursive: true })
  // `origin.git` does not exist yet, so init it from the scratch dir — a missing `cwd` surfaces
  // as a misleading `spawn git ENOENT`.
  await git(['init', '--bare', '-q', originPath], scratchDir)
  await git(['init', '-q'], repoPath)
  await git(['config', 'user.email', 'remote-branch@example.invalid'], repoPath)
  await git(['config', 'user.name', 'Remote Branch Removal'], repoPath)
  await writeFile(join(repoPath, 'seed.txt'), 'seed\n')
  await git(['add', '-A'], repoPath)
  await git(['commit', '-qm', 'seed'], repoPath)
  await git(['remote', 'add', 'origin', originPath], repoPath)
  await git(['push', '-q', '-u', 'origin', 'HEAD'], repoPath)
  await git(['worktree', 'add', '-q', worktreePath, '-b', 'feature'], repoPath)
})

afterEach(async () => {
  await whenWorktreeTrashDeletionsSettled()
  await rm(scratchDir, { recursive: true, force: true })
})

/** Publishes `feature` so it has a real upstream, and leaves the worktree clean. */
async function publishFeature(): Promise<void> {
  await writeFile(join(worktreePath, 'feature.txt'), 'feature\n')
  await git(['add', '-A'], worktreePath)
  await git(['commit', '-qm', 'feature'], worktreePath)
  await git(['push', '-q', '--set-upstream', 'origin', 'feature'], worktreePath)
}

describe('removeWorktree with deleteRemoteBranch', () => {
  it('deletes the branch on the remote and says so', async () => {
    await publishFeature()
    expect(await originHasBranch('feature')).toBe(true)

    const result = await removeWorktree(repoPath, worktreePath, false, {
      deleteRemoteBranch: true
    })

    expect(result.remoteBranchCleanup).toEqual({
      status: 'deleted',
      remoteName: 'origin',
      branchName: 'feature'
    })
    expect(await originHasBranch('feature')).toBe(false)
  })

  it('leaves the remote branch alone when the option is off', async () => {
    await publishFeature()

    const result = await removeWorktree(repoPath, worktreePath, false, {})

    expect(result.remoteBranchCleanup).toBeUndefined()
    expect(await originHasBranch('feature')).toBe(true)
  })

  // `git push --delete` has no server-side refusal, so a branch Git kept locally — unpushed
  // commits here — must keep its remote too, or removal could discard the only remaining copy.
  it('keeps the remote branch when local unpushed commits make Git preserve the branch', async () => {
    await publishFeature()
    await writeFile(join(worktreePath, 'unpushed.txt'), 'unpushed\n')
    await git(['add', '-A'], worktreePath)
    await git(['commit', '-qm', 'unpushed'], worktreePath)

    const result = await removeWorktree(repoPath, worktreePath, false, {
      deleteRemoteBranch: true
    })

    expect(result.preservedBranch?.branchName).toBe('feature')
    expect(result.remoteBranchCleanup).toEqual({ status: 'skipped-preserved' })
    expect(await originHasBranch('feature')).toBe(true)
  })

  it('keeps the remote branch when the local branch delete is pinned off', async () => {
    await publishFeature()

    const result = await removeWorktree(repoPath, worktreePath, false, {
      deleteBranch: false,
      deleteRemoteBranch: true
    })

    expect(result.remoteBranchCleanup).toEqual({ status: 'skipped-preserved' })
    expect(await originHasBranch('feature')).toBe(true)
  })

  it('reports no upstream for a branch that has none', async () => {
    // No commits, so the branch is merged into HEAD and the local delete succeeds — which is what
    // lets the flow get far enough to discover there is no upstream to target.
    const result = await removeWorktree(repoPath, worktreePath, false, {
      deleteRemoteBranch: true
    })

    expect(result.preservedBranch).toBeUndefined()
    expect(result.remoteBranchCleanup).toEqual({ status: 'no-upstream' })
    expect(await originHasBranch('feature')).toBe(false)
  })

  // Documents why resolution has to happen before the branch delete: `git branch -d` (and Orca's
  // own `config --remove-section`) take the upstream with it, so a later resolve would find nothing.
  it('resolves the upstream that the local branch delete destroys', async () => {
    await publishFeature()
    expect(await git(['config', '--get', 'branch.feature.remote'], repoPath)).toBe('origin\n')

    // The branch has to leave its worktree before Git will delete it at all.
    await git(['worktree', 'remove', '--force', worktreePath], repoPath)
    await git(['branch', '-d', '--', 'feature'], repoPath)

    await expect(git(['rev-parse', '--abbrev-ref', 'feature@{u}'], repoPath)).rejects.toThrow()
    await expect(git(['config', '--get', 'branch.feature.remote'], repoPath)).rejects.toThrow()
  })
})
