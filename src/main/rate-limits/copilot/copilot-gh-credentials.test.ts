import { beforeEach, describe, expect, it, vi } from 'vitest'

type GhResult = { stdout: string; stderr: string }

const { ghExecFileAsyncMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn<(args: string[], options?: unknown) => Promise<GhResult>>()
}))

// Why: credential discovery shells out to `gh`; mocking that module keeps the suite off
// the real CLI while leaving the real `gh auth status` parser in play.
vi.mock('../../git/command-runner/gh-exec-file', () => ({
  ghExecFileAsync: ghExecFileAsyncMock
}))

import {
  __resetCopilotGhCredentialsCache,
  resolveGhCopilotCredentials
} from './copilot-gh-credentials'

const COPILOT_USER_SCOPE = 'user'

type AccountFixture = { account: string; active?: boolean; scopes?: string[] }

function authStatusText(accounts: AccountFixture[]): GhResult {
  const lines = ['github.com']
  for (const entry of accounts) {
    lines.push(`  ✓ Logged in to github.com account ${entry.account} (keyring)`)
    lines.push(`  - Active account: ${entry.active === true ? 'true' : 'false'}`)
    if (entry.scopes && entry.scopes.length > 0) {
      lines.push(`  - Token scopes: ${entry.scopes.map((scope) => `'${scope}'`).join(', ')}`)
    }
  }
  return { stdout: '', stderr: lines.join('\n') }
}

/** The common fixture: one signed-in account holding the given scopes. */
function signedIn(scopes: string[]): GhResult {
  return authStatusText([{ account: 'octocat', active: true, scopes }])
}

function ghEnoent(): Error & { code: string } {
  return Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
}

describe('resolveGhCopilotCredentials', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    // The status probe is cached separately from direct credential resolution.
    __resetCopilotGhCredentialsCache()
  })

  it('reports gh-missing when the CLI is not on PATH', async () => {
    ghExecFileAsyncMock.mockRejectedValueOnce(ghEnoent())

    await expect(resolveGhCopilotCredentials()).resolves.toEqual({ status: 'gh-missing' })

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(ghExecFileAsyncMock.mock.calls[0]?.[0]).toEqual(['auth', 'status'])
  })

  it('reports unauthenticated when gh auth status names no account', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: '',
      stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login'
    })

    await expect(resolveGhCopilotCredentials()).resolves.toEqual({ status: 'unauthenticated' })
  })

  it('reports unauthenticated when gh auth status exits non-zero', async () => {
    ghExecFileAsyncMock.mockRejectedValueOnce(
      Object.assign(new Error('gh auth status failed'), { stderr: 'not logged in' })
    )

    await expect(resolveGhCopilotCredentials()).resolves.toEqual({ status: 'unauthenticated' })
  })

  it('reports unauthenticated when gh names an account but prints no scopes', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce(authStatusText([{ account: 'octocat' }]))

    // An empty scope list is indistinguishable from signed out, and the provider
    // fails closed rather than showing a permanent error bar to every user.
    await expect(resolveGhCopilotCredentials()).resolves.toEqual({ status: 'unauthenticated' })
  })

  const MISSING_SCOPE_CASES: [string, string[], string[]][] = [
    ['no user scope', ['repo', 'gist'], [COPILOT_USER_SCOPE]],
    [
      'enterprise scopes without the user scope',
      ['read:enterprise', 'manage_billing:enterprise'],
      [COPILOT_USER_SCOPE]
    ],
    ['a lookalike scope name', ['user:extra'], [COPILOT_USER_SCOPE]]
  ]

  it.each(MISSING_SCOPE_CASES)(
    'lists exactly the absent scopes for %s',
    async (_label, scopes, missing) => {
      ghExecFileAsyncMock.mockResolvedValueOnce(signedIn(scopes))

      await expect(resolveGhCopilotCredentials()).resolves.toEqual({
        status: 'missing-scope',
        missing
      })
    }
  )

  it('accepts a token holding the user scope', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce(signedIn(['repo', COPILOT_USER_SCOPE]))

    await expect(resolveGhCopilotCredentials()).resolves.toEqual({ status: 'ok' })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('reads the scopes of the active account when several are signed in', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce(
      authStatusText([
        { account: 'old-user', active: false, scopes: [COPILOT_USER_SCOPE] },
        { account: 'new-user', active: true, scopes: ['repo'] }
      ])
    )

    await expect(resolveGhCopilotCredentials()).resolves.toEqual({
      status: 'missing-scope',
      missing: [COPILOT_USER_SCOPE]
    })
  })

  it('checks the active GitHub CLI account each time credentials are resolved', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce(signedIn([COPILOT_USER_SCOPE]))
      .mockResolvedValueOnce(signedIn([COPILOT_USER_SCOPE]))

    const first = await resolveGhCopilotCredentials()
    const second = await resolveGhCopilotCredentials()

    expect(first).toEqual({ status: 'ok' })
    expect(second).toEqual({ status: 'ok' })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })
})
