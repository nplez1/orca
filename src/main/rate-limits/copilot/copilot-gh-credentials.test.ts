import { beforeEach, describe, expect, it, vi } from 'vitest'

type GhResult = { stdout: string; stderr: string }

const { ghExecFileAsyncMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn<(args: string[], options?: unknown) => Promise<GhResult>>()
}))

// Why: discovery shells out to `gh` twice; mocking that module keeps the suite off
// the real CLI while leaving the real `gh auth status` parser in play.
vi.mock('../../git/command-runner/gh-exec-file', () => ({
  ghExecFileAsync: ghExecFileAsyncMock
}))

import {
  __resetCopilotGhCredentialsCache,
  resolveGhCopilotCredentials
} from './copilot-gh-credentials'

const SLUG_QUERY = '{ viewer { enterprises(first: 10) { nodes { slug } } } }'
const ENTERPRISE_SCOPES = ['read:enterprise', 'manage_billing:enterprise']

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

function graphqlNodes(nodes: unknown[]): GhResult {
  return { stdout: JSON.stringify({ data: { viewer: { enterprises: { nodes } } } }), stderr: '' }
}

function ghEnoent(): Error & { code: string } {
  return Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
}

function grapqlCallCount(): number {
  return ghExecFileAsyncMock.mock.calls.filter(([args]) => args.includes('graphql')).length
}

function discover(slugs: unknown[]): void {
  ghExecFileAsyncMock.mockResolvedValueOnce(graphqlNodes(slugs))
}

describe('resolveGhCopilotCredentials', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    // Discovery is memoised across calls; each case starts from a cold cache.
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

    expect(grapqlCallCount()).toBe(0)
  })

  it('reports unauthenticated when gh auth status exits non-zero', async () => {
    ghExecFileAsyncMock.mockRejectedValueOnce(
      Object.assign(new Error('gh auth status failed'), { stderr: 'not logged in' })
    )

    await expect(resolveGhCopilotCredentials()).resolves.toEqual({ status: 'unauthenticated' })

    expect(grapqlCallCount()).toBe(0)
  })

  it('reports unauthenticated when gh names an account but prints no scopes', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce(authStatusText([{ account: 'octocat' }]))

    // An empty scope list is indistinguishable from signed out, and the provider
    // fails closed rather than showing a permanent error bar to every user.
    await expect(resolveGhCopilotCredentials()).resolves.toEqual({ status: 'unauthenticated' })
  })

  const MISSING_SCOPE_CASES: [string, string[], string[]][] = [
    [
      'no enterprise scopes at all',
      ['repo', 'gist'],
      ['read:enterprise', 'manage_billing:enterprise']
    ],
    ['read:enterprise but no billing scope', ['read:enterprise'], ['manage_billing:enterprise']],
    ['billing scope but no read:enterprise', ['manage_billing:enterprise'], ['read:enterprise']],
    [
      'a lookalike scope name',
      ['read:enterprise:extra', 'manage_billing:enterprise:extra'],
      ['read:enterprise', 'manage_billing:enterprise']
    ]
  ]

  it.each(MISSING_SCOPE_CASES)(
    'lists exactly the absent scopes for %s',
    async (_label, scopes, missing) => {
      ghExecFileAsyncMock.mockResolvedValueOnce(signedIn(scopes))

      await expect(resolveGhCopilotCredentials()).resolves.toEqual({
        status: 'missing-scope',
        missing
      })

      // Why: discovery would fail with INSUFFICIENT_SCOPES, so it is not attempted.
      expect(grapqlCallCount()).toBe(0)
    }
  )

  it('accepts admin:enterprise as implying both enterprise scopes', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce(signedIn(['repo', 'admin:enterprise']))
    discover([{ slug: 'acme-corp' }])

    await expect(resolveGhCopilotCredentials()).resolves.toEqual({
      status: 'ok',
      enterpriseSlug: 'acme-corp'
    })

    expect(ghExecFileAsyncMock.mock.calls[1]?.[0]).toEqual([
      'api',
      'graphql',
      '-f',
      `query=${SLUG_QUERY}`
    ])
  })

  it('accepts a token holding both documented scopes', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce(signedIn(['repo', ...ENTERPRISE_SCOPES]))
    discover([{ slug: 'acme-corp' }])

    await expect(resolveGhCopilotCredentials()).resolves.toEqual({
      status: 'ok',
      enterpriseSlug: 'acme-corp'
    })
  })

  it('reads the scopes of the active account when several are signed in', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce(
      authStatusText([
        { account: 'old-user', active: false, scopes: ['repo'] },
        { account: 'new-user', active: true, scopes: ['admin:enterprise'] }
      ])
    )
    discover([{ slug: 'acme-corp' }])

    await expect(resolveGhCopilotCredentials()).resolves.toEqual({
      status: 'ok',
      enterpriseSlug: 'acme-corp'
    })
  })

  it('takes the first enterprise slug from the GraphQL payload', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce(signedIn(ENTERPRISE_SCOPES))
    discover([{ slug: 'acme-corp' }, { slug: 'second-corp' }])

    await expect(resolveGhCopilotCredentials()).resolves.toEqual({
      status: 'ok',
      enterpriseSlug: 'acme-corp'
    })
  })

  it('trims the discovered slug', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce(signedIn(ENTERPRISE_SCOPES))
    discover([{ slug: '  acme-corp  ' }])

    await expect(resolveGhCopilotCredentials()).resolves.toEqual({
      status: 'ok',
      enterpriseSlug: 'acme-corp'
    })
  })

  it('skips nodes without a usable slug', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce(signedIn(ENTERPRISE_SCOPES))
    discover([null, 7, {}, { slug: '' }, { slug: 'acme-corp' }])

    await expect(resolveGhCopilotCredentials()).resolves.toEqual({
      status: 'ok',
      enterpriseSlug: 'acme-corp'
    })
  })

  it('reports no-enterprise when the signed-in login belongs to none', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce(signedIn(ENTERPRISE_SCOPES))
    discover([])

    await expect(resolveGhCopilotCredentials()).resolves.toEqual({ status: 'no-enterprise' })
  })

  it('reports no-enterprise when the payload carries no enterprises field', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce(signedIn(ENTERPRISE_SCOPES))
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '{}', stderr: '' })

    await expect(resolveGhCopilotCredentials()).resolves.toEqual({ status: 'no-enterprise' })
  })

  it('reports no-enterprise rather than a scope error when the query itself fails', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce(signedIn(ENTERPRISE_SCOPES))
    ghExecFileAsyncMock.mockRejectedValueOnce(
      Object.assign(new Error('gh: INSUFFICIENT_SCOPES (HTTP 200)'), {
        stderr: 'INSUFFICIENT_SCOPES'
      })
    )

    await expect(resolveGhCopilotCredentials()).resolves.toEqual({ status: 'no-enterprise' })
  })

  it('reports no-enterprise when the GraphQL payload is unreadable JSON', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce(signedIn(ENTERPRISE_SCOPES))
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '<html>not json</html>', stderr: '' })

    await expect(resolveGhCopilotCredentials()).resolves.toEqual({ status: 'no-enterprise' })
  })

  it('reuses the discovered slug on a second call instead of re-running discovery', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce(signedIn(ENTERPRISE_SCOPES))
      .mockResolvedValueOnce(graphqlNodes([{ slug: 'acme-corp' }]))
      .mockResolvedValueOnce(signedIn(ENTERPRISE_SCOPES))

    const first = await resolveGhCopilotCredentials()
    const second = await resolveGhCopilotCredentials()

    expect(first).toEqual({ status: 'ok', enterpriseSlug: 'acme-corp' })
    expect(second).toEqual({ status: 'ok', enterpriseSlug: 'acme-corp' })
    expect(grapqlCallCount()).toBe(1)
    // Only the auth check repeats: two calls, one graphql.
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(3)
  })

  it('re-runs discovery once the cache is reset', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce(signedIn(ENTERPRISE_SCOPES))
      .mockResolvedValueOnce(graphqlNodes([{ slug: 'acme-corp' }]))

    await expect(resolveGhCopilotCredentials()).resolves.toEqual({
      status: 'ok',
      enterpriseSlug: 'acme-corp'
    })

    __resetCopilotGhCredentialsCache()
    ghExecFileAsyncMock
      .mockResolvedValueOnce(signedIn(ENTERPRISE_SCOPES))
      .mockResolvedValueOnce(graphqlNodes([{ slug: 'other-corp' }]))

    await expect(resolveGhCopilotCredentials()).resolves.toEqual({
      status: 'ok',
      enterpriseSlug: 'other-corp'
    })
    expect(grapqlCallCount()).toBe(2)
  })
})
