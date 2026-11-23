import { generateKeyPairSync } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  removeGithubAppCredentials,
  writeGithubAppCredentials
} from '../github/app/github-app-credentials'
import { forgetInstallationTokens } from '../github/app/github-app-installation-token'

const fetchMock = vi.hoisted(() => vi.fn())
vi.mock('../host/electron-http-client', () => ({ electronHttpClient: { fetch: fetchMock } }))

const { botGithubAppLaunch } = await import('./bot-gh-app-identity')

const privateKeyPem = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' })
  .toString()

const connected = (
  installations: Parameters<typeof writeGithubAppCredentials>[0]['installations']
) =>
  writeGithubAppCredentials({ appId: 5739055, slug: 'lab-agent-np', privateKeyPem, installations })

const minted = (): Response =>
  new Response(JSON.stringify({ token: 'ghs_abc', expires_at: '2026-11-23T09:18:11Z' }), {
    status: 201
  })

const refused = (): Response =>
  new Response(JSON.stringify({ message: 'Server Error' }), { status: 500 })

beforeEach(async () => {
  forgetInstallationTokens()
  await removeGithubAppCredentials()
  fetchMock.mockReset()
})

describe('a bot launch acting as the connected App', () => {
  it('fails the launch when the mint fails, rather than acting as whoever is signed in', async () => {
    await connected([
      { id: 181472560, account: 'nplez1', repositorySelection: 'all', repositories: [] }
    ])
    fetchMock.mockResolvedValue(refused())

    await expect(botGithubAppLaunch()).rejects.toThrow(/GitHub answered 500/)
  })

  it('gives the launch the App’s token, and says which installation it acted as', async () => {
    await connected([
      { id: 181472560, account: 'nplez1', repositorySelection: 'all', repositories: [] }
    ])
    fetchMock.mockResolvedValue(minted())

    const launch = await botGithubAppLaunch()

    expect(launch.env).toEqual({ GH_TOKEN: 'ghs_abc', GH_PROMPT_DISABLED: '1' })
    expect(launch.installationId).toBe(181472560)
  })

  it('acts as the installation covering the repository it was given, not merely the first', async () => {
    await connected([
      { id: 1, account: 'nplez1', repositorySelection: 'selected', repositories: ['nplez1/orca'] },
      { id: 2, account: 'acme', repositorySelection: 'selected', repositories: ['acme/widgets'] }
    ])
    fetchMock.mockResolvedValue(minted())

    const launch = await botGithubAppLaunch({ repoFullName: 'acme/widgets' })

    expect(launch.installationId).toBe(2)
  })

  it('changes nothing at all when no App is connected', async () => {
    const launch = await botGithubAppLaunch()

    expect(launch.env).toEqual({})
    expect(launch.installationId).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
