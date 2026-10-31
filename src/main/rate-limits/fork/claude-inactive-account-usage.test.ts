import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchInactiveClaudeAccountUsage } from '../claude-managed-account-usage'
import { fetchClaudeOAuthUsage } from '../claude-oauth-usage-request'
import { readClaudeOAuthCredentials } from '../claude-oauth-credentials'
import { readClaudeUsageFromCli } from './claude-cli-usage-probe'

vi.mock('../claude-oauth-usage-request', () => ({ fetchClaudeOAuthUsage: vi.fn() }))
vi.mock('../claude-oauth-credentials', () => ({
  readClaudeOAuthCredentials: vi.fn(),
  resolveClaudeOAuthCredentialReadOptions: () => undefined
}))
vi.mock('./claude-cli-usage-probe', () => ({ readClaudeUsageFromCli: vi.fn() }))
vi.mock('../../claude-accounts/claude-profile-installed-router', () => ({
  getClaudeProfileRouter: () => ({
    accountUsagePreparation: (id: string) => ({
      configDir: `/Users/x/Library/orca/claude-profiles/${id}/home`,
      envPatch: { CLAUDE_CONFIG_DIR: `/Users/x/Library/orca/claude-profiles/${id}/home` },
      provenance: `profile:${id}`
    })
  }),
  getClaudeWslProfileRouter: () => ({
    accountUsagePreparation: async (distro: string, id: string) => ({
      configDir: `/home/x/orca/${id}`,
      envPatch: { CLAUDE_CONFIG_DIR: `/home/x/orca/${id}` },
      runtime: 'wsl' as const,
      wslDistro: distro,
      provenance: `profile:${id}`
    })
  })
}))
vi.mock('../wsl/wsl-unc-access-gate', () => ({
  blockedWslDistroForPath: async () => null
}))
vi.mock('@orca/process-host', () => ({
  spawnProcess: () => {
    throw new Error('usage tests must not launch a process')
  },
  runProcess: () => {
    throw new Error('usage tests must not launch a process')
  }
}))

beforeEach(() => {
  vi.mocked(readClaudeUsageFromCli).mockReset().mockResolvedValue(null)
  vi.mocked(readClaudeOAuthCredentials).mockReset().mockResolvedValue({
    token: 'sk-ant-oat01-token',
    hasRefreshableCredentials: true,
    source: 'scoped-keychain'
  })
  vi.mocked(fetchClaudeOAuthUsage)
    .mockReset()
    .mockResolvedValue({
      provider: 'claude',
      session: { usedPercent: 33, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null,
      updatedAt: 0,
      error: null,
      status: 'ok',
      usageMetadata: { source: 'oauth', attemptedSources: ['oauth'] }
    })
})

describe('inactive Claude account previews', () => {
  it('reads the endpoint for a saved account even when the caller allows the CLI probe', async () => {
    const usage = await fetchInactiveClaudeAccountUsage(
      { id: 'account-1' },
      { allowUsagePanelSupplement: true }
    )

    // Why: one CLI start per saved account, per switcher open, is not a price a preview row is worth.
    expect(readClaudeUsageFromCli).not.toHaveBeenCalled()
    expect(fetchClaudeOAuthUsage).toHaveBeenCalledTimes(1)
    expect(usage.session?.usedPercent).toBe(33)
  })

  it('never probes a WSL account, whose login lives in the guest', async () => {
    const usage = await fetchInactiveClaudeAccountUsage(
      { id: 'account-2', managedAuthRuntime: 'wsl', wslDistro: 'Ubuntu' },
      { allowUsagePanelSupplement: true }
    )

    expect(readClaudeUsageFromCli).not.toHaveBeenCalled()
    expect(fetchClaudeOAuthUsage).toHaveBeenCalledTimes(1)
    expect(usage.status).toBe('ok')
  })
})
