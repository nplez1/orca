import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchActiveClaudeRateLimits } from '../claude-active-usage-fetch'
import { fetchClaudeOAuthUsage } from '../claude-oauth-usage-request'
import { readClaudeOAuthCredentials } from '../claude-oauth-credentials'
import { readClaudeUsageFromCli } from './claude-cli-usage-probe'

const cliReading = {
  provider: 'claude' as const,
  session: { usedPercent: 31, windowMinutes: 300, resetsAt: null, resetDescription: null },
  weekly: { usedPercent: 44, windowMinutes: 10_080, resetsAt: null, resetDescription: null },
  fableWeekly: null,
  updatedAt: 1,
  error: null,
  status: 'ok' as const,
  usageMetadata: { source: 'cli' as const, attemptedSources: ['cli' as const] }
}

vi.mock('../claude-oauth-usage-request', () => ({ fetchClaudeOAuthUsage: vi.fn() }))
vi.mock('../claude-oauth-credentials', () => ({
  readClaudeOAuthCredentials: vi.fn(),
  resolveClaudeOAuthCredentialReadOptions: () => undefined
}))
vi.mock('./claude-cli-usage-probe', () => ({ readClaudeUsageFromCli: vi.fn() }))
vi.mock('../../claude-accounts/claude-profile-installed-router', () => ({
  getClaudeProfileRouter: () => undefined,
  getClaudeWslProfileRouter: () => undefined
}))
// Why: a test must never reach a real CLI, and the endpoint below is stubbed anyway.
vi.mock('@orca/process-host', () => ({
  spawnProcess: () => {
    throw new Error('usage tests must not launch a process')
  },
  runProcess: () => {
    throw new Error('usage tests must not launch a process')
  }
}))

const profileOptions = {
  authPreparation: {
    configDir: '/Users/x/Library/orca/claude-profiles/a/home',
    envPatch: { CLAUDE_CONFIG_DIR: '/Users/x/Library/orca/claude-profiles/a/home' },
    provenance: 'profile:a'
  }
}

beforeEach(() => {
  vi.mocked(fetchClaudeOAuthUsage).mockReset()
  vi.mocked(readClaudeUsageFromCli).mockReset().mockResolvedValue(null)
  vi.mocked(readClaudeOAuthCredentials)
    .mockReset()
    .mockResolvedValue({
      token: 'sk-ant-oat01-token',
      hasRefreshableCredentials: true,
      source: 'scoped-keychain',
      refreshTarget: { kind: 'keychain', service: 'Claude Code-credentials-b872949e', account: 'x' }
    })
})

describe('Claude usage without a running session', () => {
  it('answers from the CLI probe instead of the rate-limited usage endpoint', async () => {
    vi.mocked(readClaudeUsageFromCli).mockResolvedValue(cliReading)

    const result = await fetchActiveClaudeRateLimits({
      ...profileOptions,
      allowUsagePanelSupplement: true
    })

    expect(result.session?.usedPercent).toBe(31)
    expect(result.usageMetadata?.source).toBe('cli')
    expect(result.usageMetadata?.authProvenance).toBe('profile:a')
    // The whole point: the endpoint that answers 429 was never asked.
    expect(fetchClaudeOAuthUsage).not.toHaveBeenCalled()
  })

  it('carries an open endpoint wait through a probe reading that answers', async () => {
    vi.mocked(readClaudeUsageFromCli).mockResolvedValue(cliReading)
    const retryAtMs = Date.now() + 40 * 60 * 1000

    const result = await fetchActiveClaudeRateLimits({
      ...profileOptions,
      allowUsagePanelSupplement: true,
      usageEndpointRetryAtMs: retryAtMs
    })

    // Why: a probe that answers now must not licence the endpoint while its own wait is still open.
    expect(result.session?.usedPercent).toBe(31)
    expect(result.usageMetadata?.retryAtMs).toBe(retryAtMs)
    expect(fetchClaudeOAuthUsage).not.toHaveBeenCalled()
  })

  it('keeps the endpoint closed while its Retry-After is open and the probe cannot answer', async () => {
    const now = Date.now()
    const result = await fetchActiveClaudeRateLimits({
      ...profileOptions,
      allowUsagePanelSupplement: true,
      usageEndpointRetryAtMs: now + 10 * 60 * 1000
    })

    expect(fetchClaudeOAuthUsage).not.toHaveBeenCalled()
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('rate-limited')
    expect(result.usageMetadata?.retryAtMs).toBe(now + 10 * 60 * 1000)
  })

  it('still reads the endpoint once its Retry-After has passed', async () => {
    vi.mocked(fetchClaudeOAuthUsage).mockResolvedValue({
      ...cliReading,
      usageMetadata: { source: 'oauth', attemptedSources: ['oauth'] }
    })

    const result = await fetchActiveClaudeRateLimits({
      ...profileOptions,
      allowUsagePanelSupplement: true,
      usageEndpointRetryAtMs: Date.now() - 1
    })

    expect(fetchClaudeOAuthUsage).toHaveBeenCalledTimes(1)
    expect(result.usageMetadata?.source).toBe('oauth')
  })

  it('keeps the probe out of accounts Orca already knows cannot be read', async () => {
    const result = await fetchActiveClaudeRateLimits({
      authPreparation: { ...profileOptions.authPreparation, usageError: 'Account profile missing' },
      allowUsagePanelSupplement: true
    })

    expect(readClaudeUsageFromCli).not.toHaveBeenCalled()
    expect(result.error).toBe('Account profile missing')
  })

  it('keeps the probe out of a WSL account whose login lives in the guest', async () => {
    vi.mocked(fetchClaudeOAuthUsage).mockResolvedValue({
      ...cliReading,
      usageMetadata: { source: 'oauth', attemptedSources: ['oauth'] }
    })

    await fetchActiveClaudeRateLimits({
      allowUsagePanelSupplement: true,
      authPreparation: { ...profileOptions.authPreparation, runtime: 'wsl', wslDistro: 'Ubuntu' }
    })

    expect(readClaudeUsageFromCli).not.toHaveBeenCalled()
    expect(fetchClaudeOAuthUsage).toHaveBeenCalledTimes(1)
  })

  it('leaves a platform without the probe on the endpoint alone', async () => {
    await fetchActiveClaudeRateLimits({ ...profileOptions, allowUsagePanelSupplement: false })

    expect(readClaudeUsageFromCli).not.toHaveBeenCalled()
  })

  it('publishes nothing when the cycle was aborted mid-probe', async () => {
    const controller = new AbortController()
    vi.mocked(readClaudeUsageFromCli).mockImplementation(async () => {
      controller.abort()
      return null
    })

    const result = await fetchActiveClaudeRateLimits({
      ...profileOptions,
      allowUsagePanelSupplement: true,
      signal: controller.signal
    })

    expect(result.error).toBe('Rate-limit fetch aborted')
    expect(fetchClaudeOAuthUsage).not.toHaveBeenCalled()
  })
})
