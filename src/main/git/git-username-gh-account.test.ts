import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ gitExec: vi.fn(), ghExec: vi.fn() }))

vi.mock('./runner', () => ({
  gitExecFileAsync: mocks.gitExec,
  ghExecFileAsync: mocks.ghExec,
  extractExecError: () => ({ stdout: '', stderr: '' })
}))
vi.mock('./repo', () => ({
  resolveDefaultBaseRefViaExec: async () => 'refs/remotes/origin/main'
}))

import {
  resetGhLoginCacheForTests,
  resolveLocalGitUsername,
  resolveLocalGitUsernameDetailed
} from './git-username'

/** A GitHub-remote checkout whose git config holds nothing that names a login. */
function gitConfig(
  overrides: Record<string, string> = {}
): (argv: string[]) => Promise<{ stdout: string; stderr: string }> {
  const values: Record<string, string> = {
    remote: 'origin',
    'branch --show-current': 'feature',
    'config --get branch.feature.remote': 'origin',
    'remote get-url origin': 'git@github.com:acme/repo.git',
    'config --get user.name': '',
    ...overrides
  }
  return async (argv: string[]) => {
    const stdout = values[argv.join(' ')] ?? ''
    if (!stdout) {
      throw new Error(`git ${argv.join(' ')} failed`)
    }
    return { stdout, stderr: '' }
  }
}

const bound = { host: 'github.com', user: 'bound-user' }

beforeEach(() => {
  resetGhLoginCacheForTests()
  mocks.gitExec.mockReset()
  mocks.ghExec.mockReset()
  mocks.gitExec.mockImplementation(gitConfig())
  mocks.ghExec.mockResolvedValue({ stdout: 'ambient-user\n', stderr: '' })
})

describe('git username account binding', () => {
  it('takes the branch prefix from the repo pinned account without probing gh', async () => {
    await expect(resolveLocalGitUsernameDetailed('/repo', bound)).resolves.toEqual({
      username: 'bound-user',
      authoritative: true
    })
    expect(mocks.ghExec).not.toHaveBeenCalled()
  })

  it('keeps probing for a binding on a host the remote gate cannot classify', async () => {
    await expect(
      resolveLocalGitUsernameDetailed('/repo', { host: 'github.acme.com', user: 'bound-user' })
    ).resolves.toEqual({ username: 'ambient-user', authoritative: true })
    expect(mocks.ghExec).toHaveBeenCalled()
  })

  it('still probes the ambient login for an unbound repo', async () => {
    await expect(resolveLocalGitUsernameDetailed('/repo')).resolves.toEqual({
      username: 'ambient-user',
      authoritative: true
    })
    expect(mocks.ghExec).toHaveBeenCalledWith(['api', 'user', '-q', '.login'], expect.anything())
  })

  it('keeps an explicit github.user config ahead of the binding', async () => {
    mocks.gitExec.mockImplementation(gitConfig({ 'config --get github.user': 'configured' }))

    await expect(resolveLocalGitUsername('/repo', bound)).resolves.toBe('configured')
    expect(mocks.ghExec).not.toHaveBeenCalled()
  })
})
