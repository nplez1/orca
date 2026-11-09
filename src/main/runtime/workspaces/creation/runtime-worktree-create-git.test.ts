import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitHubClient from '../../../github/client/lookup/get-pr-for-branch'

const getPRForBranchMock = vi.hoisted(() => vi.fn())
const git = vi.hoisted(() => vi.fn())
const worktrees = vi.hoisted(() => vi.fn())
vi.mock('../../../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: git
}))
vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', () => ({
  listWorktrees: worktrees
}))

vi.mock('../../../github/client/lookup/get-pr-for-branch', async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubClient>()),
  getPRForBranch: getPRForBranchMock
}))

import { canCheckoutExistingLocalBranch, getLocalGitHubPrForBranch } from './runtime-worktree-create-git'

beforeEach(() => {
  getPRForBranchMock.mockReset()
  getPRForBranchMock.mockResolvedValue(null)
  git.mockReset()
  worktrees.mockReset()
})

describe('explicit local branch reuse on the execution host', () => {
  it('rejects a filesystem alias before attempting checkout through WSL', async () => {
    git.mockResolvedValueOnce({ stdout: 'local-ahead\n' })
    git.mockResolvedValueOnce({ stdout: '' })
    await expect(
      canCheckoutExistingLocalBranch(
        '/repo',
        'feature/TEST',
        'origin/feature/test',
        { wslDistro: 'Ubuntu' },
        true
      )
    ).rejects.toThrow('Select its exact branch name')
    expect(worktrees).not.toHaveBeenCalled()
  })

  it('detects a busy alias recorded by an older checkout through WSL', async () => {
    git.mockResolvedValueOnce({ stdout: 'local-ahead\n' })
    git.mockResolvedValueOnce({ stdout: 'refs/heads/feature/test\n' })
    git.mockResolvedValueOnce({ stdout: '' })
    worktrees.mockResolvedValue([{ path: '/busy', branch: 'refs/heads/feature/TEST' }])
    await expect(
      canCheckoutExistingLocalBranch(
        '/repo',
        'feature/test',
        'origin/feature/test',
        { wslDistro: 'Ubuntu' },
        true
      )
    ).rejects.toThrow('already checked out at "/busy"')
    expect(git).toHaveBeenLastCalledWith(
      ['for-each-ref', '--format=%(refname)', 'refs/heads/feature/TEST'],
      { cwd: '/repo', wslDistro: 'Ubuntu' }
    )
  })

  it('propagates an unreadable local ref instead of treating it as permission to create', async () => {
    git.mockRejectedValue(Object.assign(new Error('permission denied'), { code: 128 }))
    await expect(
      canCheckoutExistingLocalBranch('/repo', 'feature/test', 'origin/feature/test', {}, true)
    ).rejects.toThrow('permission denied')
    expect(worktrees).not.toHaveBeenCalled()
  })
})

describe('getLocalGitHubPrForBranch', () => {
  it('routes the PR lookup through the repo pinned account on the host', async () => {
    await getLocalGitHubPrForBranch('/repo', 'app', {
      ghAccount: { host: 'github.com', user: 'Alice' }
    })

    expect(getPRForBranchMock).toHaveBeenCalledWith('/repo', 'app', null, null, null, {
      localGitExecOptions: { ghAccount: { host: 'github.com', user: 'Alice' } }
    })
  })

  it('carries the WSL route and the pinned account together', async () => {
    await getLocalGitHubPrForBranch('/repo', 'app', {
      wslDistro: 'Ubuntu',
      ghAccount: { host: 'github.acme.com', user: 'Bob' }
    })

    expect(getPRForBranchMock).toHaveBeenCalledWith('/repo', 'app', null, null, null, {
      localGitExecOptions: {
        wslDistro: 'Ubuntu',
        ghAccount: { host: 'github.acme.com', user: 'Bob' }
      }
    })
  })
})
