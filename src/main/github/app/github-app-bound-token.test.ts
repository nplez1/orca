import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { GithubAppFetch } from './github-app-api'
import type { GithubAppCredentials } from './github-app-credentials'
import { githubAppBoundToken } from './github-app-bound-token'

// A real key, because minting signs a JWT before any token comes back.
const privateKeyPem = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' })
  .toString()

function credentials(): GithubAppCredentials {
  return {
    appId: 5739055,
    slug: 'lab-agent-np',
    privateKeyPem,
    installations: [
      {
        id: 181472560,
        account: 'nplez1',
        repositorySelection: 'selected',
        repositories: ['nplez1/orca'],
        contentsWrite: true
      },
      {
        id: 181472999,
        account: 'acme',
        repositorySelection: 'all',
        repositories: [],
        contentsWrite: true
      }
    ]
  }
}

/** Answers GitHub's mint with a token naming the installation that was asked for. */
function mintingFetch(calls: string[]): GithubAppFetch {
  return async (url) => {
    calls.push(url)
    return new Response(
      JSON.stringify({
        token: `ghs_${url.includes('181472999') ? 'acme' : 'nplez1'}`,
        expires_at: null
      }),
      { status: 201 }
    )
  }
}

describe('githubAppBoundToken', () => {
  it('mints through the installation covering the repository’s owner', async () => {
    const calls: string[] = []
    const minted = await githubAppBoundToken({
      host: 'github.com',
      owner: 'acme',
      credentials: credentials(),
      fetch: mintingFetch(calls)
    })
    expect(minted.installationId).toBe(181472999)
    expect(calls).toEqual(['https://api.github.com/app/installations/181472999/access_tokens'])
  })

  it('fails closed when no App is connected, rather than acting as the user', async () => {
    const error = await githubAppBoundToken({
      host: 'github.com',
      owner: 'nplez1',
      credentials: null,
      fetch: mintingFetch([])
    }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      code: 'gh_bound_account_unavailable',
      message: expect.stringContaining('No GitHub App is connected')
    })
  })

  it('names the owner the App is not installed for', async () => {
    const error = await githubAppBoundToken({
      host: 'github.com',
      owner: 'someone-else',
      credentials: credentials(),
      fetch: mintingFetch([])
    }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      code: 'gh_bound_account_unavailable',
      message: expect.stringContaining('someone-else')
    })
  })

  it('refuses a GitHub Enterprise host instead of pretending the App acts there', async () => {
    const error = await githubAppBoundToken({
      host: 'ghe.example.com',
      owner: 'nplez1',
      credentials: credentials(),
      fetch: mintingFetch([])
    }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      code: 'gh_bound_account_unavailable',
      message: expect.stringContaining('ghe.example.com')
    })
  })
})
