import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))

vi.mock('../github/gh-utils', () => ({
  acquire: vi.fn(),
  release: vi.fn(),
  ghExecFileAsync: vi.fn(),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../providers/ssh-git-dispatch', () => ({ getSshGitProvider: vi.fn(() => null) }))

import { getDefaultBaseRef } from './hosted-review-creation-git-state'

beforeEach(() => {
  gitExecFileAsyncMock.mockReset()
})

describe('getDefaultBaseRef (review base)', () => {
  // Why: a fork's own default branch is not what its reviews merge into. Taking
  // it as the base made the review carry every fork-local commit, so on a fork
  // checkout the base comes from the upstream parent.
  it('prefers the upstream parent default on a fork checkout', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: `${args.at(-1)?.replace(/\/HEAD$/, '')}/main\n`, stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.at(-1) === 'refs/remotes/upstream/main') {
        return { stdout: 'upstream-sha\n', stderr: '' }
      }
      throw new Error('missing ref')
    })

    await expect(getDefaultBaseRef('/repo-root', 'local')).resolves.toBe('upstream/main')
  })

  it('keeps the checkout default when there is no upstream remote', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        throw new Error('no symbolic ref')
      }
      if (args[0] === 'rev-parse' && args.at(-1) === 'refs/remotes/origin/main') {
        return { stdout: 'origin-sha\n', stderr: '' }
      }
      throw new Error('missing ref')
    })

    await expect(getDefaultBaseRef('/repo-root', 'local')).resolves.toBe('origin/main')
  })
})
