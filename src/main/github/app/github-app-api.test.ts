import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { mintInstallationToken, readGithubApp, type GithubAppFetch } from './github-app-api'
import { forgetInstallationTokens, installationToken } from './github-app-installation-token'
import type { GithubAppCredentials } from './github-app-credentials'

// A real key, because every App call signs a JWT before it is sent.
const keyPair = {
  appId: 5739055,
  privateKeyPem: generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs1', format: 'pem' })
    .toString()
}

function credentials(): GithubAppCredentials {
  return {
    appId: keyPair.appId,
    slug: 'lab-agent-np',
    privateKeyPem: keyPair.privateKeyPem,
    installations: [
      {
        id: 181472560,
        account: 'nplez1',
        repositorySelection: 'selected',
        repositories: ['nplez1/orca']
      }
    ]
  }
}

function responder(replies: { status?: number; body: unknown }[]): {
  fetch: GithubAppFetch
  calls: { url: string; init: RequestInit | undefined }[]
} {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  let index = 0
  const fetch: GithubAppFetch = async (url, init) => {
    calls.push({ url, init })
    const reply = replies[Math.min(index++, replies.length - 1)]
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 })
  }
  return { fetch, calls }
}

describe('readGithubApp', () => {
  it('names the App from GET /app and signs the call rather than sending a token', async () => {
    const { fetch, calls } = responder([{ body: { id: 5739055, slug: 'lab-agent-np' } }])

    await expect(readGithubApp({ ...keyPair, fetch, nowMs: 1_700_000_000_000 })).resolves.toEqual({
      id: 5739055,
      slug: 'lab-agent-np'
    })

    expect(calls[0]?.url).toBe('https://api.github.com/app')
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers.Authorization.startsWith('Bearer eyJ')).toBe(true)
  })

  it('separates a refused key from a missing App, because the fixes differ', async () => {
    const refused = responder([{ status: 401, body: { message: 'Bad credentials' } }])
    await expect(readGithubApp({ ...keyPair, fetch: refused.fetch })).rejects.toThrow(
      /key and the app id/
    )

    const missing = responder([{ status: 404, body: { message: 'Integration not found' } }])
    await expect(readGithubApp({ ...keyPair, fetch: missing.fetch })).rejects.toThrow(
      /app id and the installation id/
    )
  })
})

describe('mintInstallationToken', () => {
  it('carries the token and its expiry, and never puts the key in the request', async () => {
    const { fetch, calls } = responder([
      { status: 201, body: { token: 'ghs_abc', expires_at: '2026-11-23T09:18:11Z' } }
    ])

    const minted = await mintInstallationToken({ ...keyPair, installationId: 181472560, fetch })

    expect(minted).toEqual({ token: 'ghs_abc', expiresAtMs: Date.parse('2026-11-23T09:18:11Z') })
    expect(calls[0]?.url).toBe('https://api.github.com/app/installations/181472560/access_tokens')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(JSON.stringify(calls[0]?.init)).not.toContain('PRIVATE KEY')
  })
})

describe('installationToken', () => {
  it('reuses a token until it is inside the refresh margin, then mints once for concurrent callers', async () => {
    forgetInstallationTokens()
    const expiresAt = '2026-11-23T09:18:11Z'
    const { fetch, calls } = responder([
      { status: 201, body: { token: 'ghs_abc', expires_at: expiresAt } }
    ])
    const expiresAtMs = Date.parse(expiresAt)
    const input = { credentials: credentials(), installationId: 181472560, fetch }

    expect(await installationToken({ ...input, nowMs: expiresAtMs - 3_600_000 })).toBe('ghs_abc')
    expect(await installationToken({ ...input, nowMs: expiresAtMs - 3_000_000 })).toBe('ghs_abc')
    expect(calls).toHaveLength(1)

    // Nine of the sixty minutes left is inside the ten-minute margin: a fresh one is due.
    const both = await Promise.all([
      installationToken({ ...input, nowMs: expiresAtMs - 540_000 }),
      installationToken({ ...input, nowMs: expiresAtMs - 540_000 })
    ])
    expect(both).toEqual(['ghs_abc', 'ghs_abc'])
    expect(calls).toHaveLength(2)
  })

  it('does not trust a token whose expiry GitHub did not state', async () => {
    forgetInstallationTokens()
    const { fetch, calls } = responder([{ status: 201, body: { token: 'ghs_abc' } }])
    const input = { credentials: credentials(), installationId: 181472560, fetch }

    await installationToken({ ...input, nowMs: 1_700_000_000_000 })
    await installationToken({ ...input, nowMs: 1_700_000_001_000 })

    expect(calls).toHaveLength(2)
  })
})

describe('forgetInstallationTokens', () => {
  it('drops the cached token so a re-keyed App is not served the old one', async () => {
    forgetInstallationTokens()
    const expiresAt = '2026-11-23T09:18:11Z'
    const { fetch, calls } = responder([
      { status: 201, body: { token: 'ghs_abc', expires_at: expiresAt } }
    ])
    const input = {
      credentials: credentials(),
      installationId: 181472560,
      fetch,
      nowMs: Date.parse(expiresAt) - 3_600_000
    }

    await installationToken(input)
    forgetInstallationTokens(181472560)
    await installationToken(input)

    expect(calls).toHaveLength(2)
  })
})
