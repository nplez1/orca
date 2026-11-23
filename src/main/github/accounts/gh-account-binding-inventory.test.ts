import { describe, expect, it, vi } from 'vitest'

const { getGhMultiAccountCapability, diagnoseGhAuth } = vi.hoisted(() => ({
  getGhMultiAccountCapability: vi.fn(async () => 'supported' as const),
  diagnoseGhAuth: vi.fn(async () => ({ accounts: [] }))
}))

vi.mock('./gh-capability-state', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGhMultiAccountCapability
}))

vi.mock('./auth-diagnose', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  diagnoseGhAuth
}))

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

vi.mock('../app/github-app-credentials', () => ({
  readGithubAppCredentials: async () => credentials
}))

const { validateGhAccountBinding } = await import('./gh-account-binding-inventory')

describe('validateGhAccountBinding, for a GitHub App binding', () => {
  it('accepts the connected App without asking `gh` anything', async () => {
    await expect(
      validateGhAccountBinding({ host: 'github.com', user: 'lab-agent-np[bot]', kind: 'app' })
    ).resolves.toEqual({
      ok: true,
      binding: { host: 'github.com', user: 'lab-agent-np[bot]', kind: 'app' }
    })
    expect(getGhMultiAccountCapability).not.toHaveBeenCalled()
    expect(diagnoseGhAuth).not.toHaveBeenCalled()
  })

  it('refuses an App this computer is not connected to', async () => {
    await expect(
      validateGhAccountBinding({ host: 'github.com', user: 'other-app[bot]', kind: 'app' })
    ).resolves.toEqual({ ok: false, error: 'github_app_unavailable' })
    expect(getGhMultiAccountCapability).not.toHaveBeenCalled()
  })
})
