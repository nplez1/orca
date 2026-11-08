import { describe, expect, it, vi } from 'vitest'
import { materializeCopiedPushTargetBase } from './worktree-create-push-target-base'
import type { GitPushTarget } from '../shared/worktree/types'

const FORK_URL = 'git@github.com:alice/orca.git'

function copiedTarget(overrides: Partial<GitPushTarget> = {}): GitPushTarget {
  return { remoteName: 'fork', branchName: 'feature/fix-login', remoteUrl: FORK_URL, ...overrides }
}

describe('materializeCopiedPushTargetBase', () => {
  it('recreates the remote a copied workspace publishes to, then starts from the prepared name', async () => {
    const prepare = vi.fn(async (target: GitPushTarget) => ({ ...target, remoteName: 'fork-2' }))

    const result = await materializeCopiedPushTargetBase({
      request: {
        exactBranchName: true,
        baseBranch: 'fork/feature/fix-login',
        pushTarget: copiedTarget()
      },
      prepare
    })

    expect(prepare).toHaveBeenCalledWith(copiedTarget())
    // Why the prepared name: a taken remote name is suffixed, so only it names the fetched ref.
    expect(result).toEqual({
      baseBranch: 'fork-2/feature/fix-login',
      pushTarget: { remoteName: 'fork-2', branchName: 'feature/fix-login', remoteUrl: FORK_URL },
      materialized: true
    })
  })

  it.each([
    ['a normal create', { baseBranch: 'origin/feature/x' }],
    ['a create that keeps no branch name', { exactBranchName: false }],
    ['a base that names another remote', { baseBranch: 'origin/feature/fix-login' }],
    ['a push target without a URL', { pushTarget: { remoteName: 'fork', branchName: 'fix' } }]
  ])('leaves %s untouched', async (_label, overrides) => {
    const prepare = vi.fn(async (target: GitPushTarget) => target)
    const request = {
      exactBranchName: true,
      baseBranch: 'fork/feature/fix-login',
      pushTarget: copiedTarget(),
      ...overrides
    }

    const result = await materializeCopiedPushTargetBase({ request, prepare })

    expect(prepare).not.toHaveBeenCalled()
    expect(result).toEqual({
      baseBranch: request.baseBranch,
      pushTarget: request.pushTarget,
      materialized: false
    })
  })

  it('leaves a create with no push target alone', async () => {
    const prepare = vi.fn(async (target: GitPushTarget) => target)

    const result = await materializeCopiedPushTargetBase({
      request: { exactBranchName: true, baseBranch: 'origin/main' },
      prepare
    })

    expect(prepare).not.toHaveBeenCalled()
    expect(result).toEqual({ baseBranch: 'origin/main', pushTarget: undefined, materialized: false })
  })
})
