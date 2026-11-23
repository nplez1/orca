import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type * as CredentialsModule from './github-app-credentials'
import type * as InstallationTokenModule from './github-app-installation-token'
import type { GithubAppFetch } from './github-app-api'
import type { GithubAppCredentials } from './github-app-credentials'

// A real key, because connecting signs a JWT before it sends anything; it belongs to no App.
const privateKeyPem = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' })
  .toString()

type CredentialStore = {
  stored: GithubAppCredentials | null
  writes: GithubAppCredentials[]
  readFailure: string | null
}

const store = vi.hoisted((): CredentialStore => ({ stored: null, writes: [], readFailure: null }))
const forgotten = vi.hoisted(() => vi.fn())

vi.mock('./github-app-credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof CredentialsModule>()
  return {
    ...actual,
    readGithubAppCredentials: async () => {
      if (store.readFailure) {
        throw new Error(store.readFailure)
      }
      return store.stored
    },
    writeGithubAppCredentials: async (credentials: GithubAppCredentials) => {
      store.stored = credentials
      store.writes.push(credentials)
    },
    removeGithubAppCredentials: async () => {
      store.stored = null
    }
  }
})

vi.mock('./github-app-installation-token', async (importOriginal) => {
  const actual = await importOriginal<typeof InstallationTokenModule>()
  return { ...actual, forgetInstallationTokens: forgotten }
})

const { connectGithubApp, disconnectGithubApp, githubAppStatus } =
  await import('./github-app-connection')

type Reply = { status?: number; body: unknown }

/** Answers by URL, because a connect makes four calls whose order the App does not depend on. */
function responder(routes: [RegExp, Reply][]): {
  fetch: GithubAppFetch
  calls: { url: string; init: RequestInit | undefined }[]
} {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const fetch: GithubAppFetch = async (url, init) => {
    calls.push({ url, init })
    const route = routes.find(([pattern]) => pattern.test(url))
    if (!route) {
      return new Response('{}', { status: 404 })
    }
    return new Response(JSON.stringify(route[1].body), { status: route[1].status ?? 200 })
  }
  return { fetch, calls }
}

function reset(): void {
  store.stored = null
  store.writes = []
  store.readFailure = null
  forgotten.mockReset()
}

describe('connectGithubApp', () => {
  it('stores what GitHub says the App is, and which repos a selected install covers', async () => {
    reset()
    const { fetch, calls } = responder([
      [/\/app$/, { body: { id: 5739055, slug: 'lab-agent-np' } }],
      [
        /\/app\/installations\?/,
        {
          body: [
            { id: 181472560, account: { login: 'nplez1' }, repository_selection: 'selected' },
            { id: 181472561, account: { login: 'acme' }, repository_selection: 'all' }
          ]
        }
      ],
      [
        /access_tokens$/,
        { status: 201, body: { token: 'ghs_abc', expires_at: '2026-11-23T09:18:11Z' } }
      ],
      [/\/installation\/repositories/, { body: { repositories: [{ full_name: 'nplez1/orca' }] } }]
    ])

    await connectGithubApp({ appId: 5739055, privateKey: privateKeyPem, fetch })

    expect(store.writes).toHaveLength(1)
    expect(store.writes[0]).toEqual({
      appId: 5739055,
      slug: 'lab-agent-np',
      privateKeyPem,
      installations: [
        {
          id: 181472560,
          account: 'nplez1',
          repositorySelection: 'selected',
          repositories: ['nplez1/orca']
        },
        // `all` already names every repo it was given, so it costs no token to ask.
        { id: 181472561, account: 'acme', repositorySelection: 'all', repositories: [] }
      ]
    })
    expect(calls.filter((call) => call.url.endsWith('access_tokens'))).toHaveLength(1)
    const listed = calls.find((call) => call.url.includes('/installation/repositories'))
    expect(listed?.init?.headers).toMatchObject({ Authorization: 'Bearer ghs_abc' })
    // A token minted for the key just replaced must not survive the write.
    expect(forgotten).toHaveBeenCalled()
    // The key is sealed on disk; what leaves this process is a signature, never the key itself.
    expect(JSON.stringify(calls.map((call) => call.init ?? {}))).not.toContain('PRIVATE KEY')
  })

  it('refuses an App GitHub has not installed, and stores nothing', async () => {
    reset()
    const { fetch } = responder([
      [/\/app$/, { body: { id: 5739055, slug: 'lab-agent-np' } }],
      [/\/app\/installations\?/, { body: [] }]
    ])

    await expect(
      connectGithubApp({ appId: 5739055, privateKey: privateKeyPem, fetch })
    ).rejects.toThrow(/Install the App on the repositories/)
    expect(store.writes).toHaveLength(0)
  })

  it('refuses text that is not a private key without asking GitHub', async () => {
    reset()
    const { fetch, calls } = responder([])

    await expect(
      connectGithubApp({ appId: 5739055, privateKey: 'ghp_notakey', fetch })
    ).rejects.toThrow(/not a private key/)
    expect(calls).toHaveLength(0)
  })

  it('passes GitHub’s own refusal through, so the fix is named', async () => {
    reset()
    const { fetch } = responder([[/\/app$/, { status: 401, body: { message: 'Bad credentials' } }]])

    await expect(connectGithubApp({ appId: 1, privateKey: privateKeyPem, fetch })).rejects.toThrow(
      /key and the app id/
    )
    expect(store.writes).toHaveLength(0)
  })
})

describe('githubAppStatus', () => {
  it('names the App’s identity and carries neither the key nor a token', async () => {
    reset()
    store.stored = {
      appId: 5739055,
      slug: 'lab-agent-np',
      privateKeyPem,
      installations: [
        { id: 181472560, account: 'nplez1', repositorySelection: 'selected', repositories: [] }
      ]
    }

    const status = await githubAppStatus()

    expect(status).toEqual({
      connected: true,
      appId: 5739055,
      login: 'lab-agent-np[bot]',
      installations: [
        { id: 181472560, account: 'nplez1', repositorySelection: 'selected', repositories: [] }
      ]
    })
    expect(JSON.stringify(status)).not.toContain('PRIVATE KEY')
  })

  it('reads a connection it cannot open as one to fix, not as none', async () => {
    reset()
    store.readFailure = 'Orca can’t lock a GitHub App key on this computer'

    await expect(githubAppStatus()).resolves.toEqual({
      connected: false,
      unreadable: 'Orca can’t lock a GitHub App key on this computer'
    })
  })
})

describe('disconnectGithubApp', () => {
  it('removes the stored App and forgets its tokens', async () => {
    reset()
    store.stored = {
      appId: 5739055,
      slug: 'lab-agent-np',
      privateKeyPem,
      installations: []
    }

    await disconnectGithubApp()

    expect(store.stored).toBeNull()
    expect(forgotten).toHaveBeenCalled()
  })
})
