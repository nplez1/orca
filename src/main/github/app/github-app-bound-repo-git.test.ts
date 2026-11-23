import { describe, expect, it, vi } from 'vitest'

const credentials = {
  appId: 5739055,
  slug: 'lab-agent-np',
  privateKeyPem: 'sealed:key',
  installations: [
    {
      id: 181472560,
      account: 'nplez1',
      repositorySelection: 'all' as const,
      repositories: [],
      contentsWrite: true
    }
  ]
}

vi.mock('./github-app-credentials', () => ({
  readGithubAppCredentials: async () => credentials
}))

const { isAppBoundGitRepo } = await import('./github-app-bound-repo-git')

const APP_BINDING = { host: 'github.com', user: 'lab-agent-np[bot]', kind: 'app' as const }

describe('isAppBoundGitRepo', () => {
  it('answers for a project bound to the connected App', async () => {
    await expect(isAppBoundGitRepo({ path: '/repos/orca', ghAccount: APP_BINDING })).resolves.toBe(
      true
    )
  })

  it('refuses a project whose git runs inside WSL, where Orca’s helper cannot run', async () => {
    const error = await isAppBoundGitRepo({
      path: '/repos/orca',
      ghAccount: APP_BINDING,
      wslDistro: 'Ubuntu'
    }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      code: 'gh_bound_account_unavailable',
      message: expect.stringContaining('WSL distro Ubuntu')
    })
  })

  it('leaves a project bound to a person alone, distro or not', async () => {
    await expect(
      isAppBoundGitRepo({
        path: '/repos/orca',
        ghAccount: { host: 'github.com', user: 'nplez1' },
        wslDistro: 'Ubuntu'
      })
    ).resolves.toBe(false)
  })
})
