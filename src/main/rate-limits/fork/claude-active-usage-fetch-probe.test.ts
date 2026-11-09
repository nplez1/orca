import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchActiveClaudeRateLimits } from '../claude-active-usage-fetch'
import { fetchClaudeOAuthUsage } from '../claude-oauth-usage-request'
import { readClaudeOAuthCredentials } from '../claude-oauth-credentials'
import { refreshClaudeOAuthCredentials } from '../../claude-accounts/claude-oauth-token-refresh'
import { OAuthUsageError } from '../claude-oauth-usage-error'
import { readClaudeUsageFromCli } from './claude-cli-usage-probe'

const RETRY_AFTER_MS = 3_593_000

/** The shape the endpoint's own 429 produces; a plain Error classifies as `unknown`, not rate-limited. */
function rateLimitedError(retryAfterMs: number | null = null): OAuthUsageError {
  return new OAuthUsageError('Rate limited. Please try again later.', 429, true, retryAfterMs)
}

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
vi.mock('../../claude-accounts/claude-oauth-token-refresh', () => ({
  refreshClaudeOAuthCredentials: vi.fn()
}))
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

// Why a constant: the gate is compared against the real clock, and a fixed far-future instant is
// the point of these cases (test-no-wall-clock forbids reading Date.now() here).
const OPEN_ENDPOINT_GATE = Date.parse('2999-01-01T00:00:00Z')

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
  it('answers from the CLI probe once the endpoint refuses', async () => {
    vi.mocked(fetchClaudeOAuthUsage).mockRejectedValueOnce(rateLimitedError())
    vi.mocked(readClaudeUsageFromCli).mockResolvedValue(cliReading)

    const result = await fetchActiveClaudeRateLimits({
      ...profileOptions,
      allowUsagePanelSupplement: true
    })

    expect(result.session?.usedPercent).toBe(31)
    expect(result.usageMetadata?.source).toBe('cli')
    expect(result.usageMetadata?.authProvenance).toBe('profile:a')
  })

  it('carries an open endpoint wait through a probe reading that answers', async () => {
    vi.mocked(readClaudeUsageFromCli).mockResolvedValue(cliReading)

    const result = await fetchActiveClaudeRateLimits({
      ...profileOptions,
      allowUsagePanelSupplement: true,
      usageEndpointRetryAtMs: OPEN_ENDPOINT_GATE
    })

    // Why: a probe that answers now must not licence the endpoint while its own wait is still open.
    expect(result.session?.usedPercent).toBe(31)
    expect(result.usageMetadata?.retryAtMs).toBe(OPEN_ENDPOINT_GATE)
    expect(fetchClaudeOAuthUsage).not.toHaveBeenCalled()
  })

  it('keeps the endpoint closed while its Retry-After is open and the probe cannot answer', async () => {
    const result = await fetchActiveClaudeRateLimits({
      ...profileOptions,
      allowUsagePanelSupplement: true,
      usageEndpointRetryAtMs: OPEN_ENDPOINT_GATE
    })

    expect(fetchClaudeOAuthUsage).not.toHaveBeenCalled()
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('rate-limited')
    expect(result.usageMetadata?.retryAtMs).toBe(OPEN_ENDPOINT_GATE)
  })

  it('still reads the endpoint once its Retry-After has passed', async () => {
    vi.mocked(fetchClaudeOAuthUsage).mockResolvedValue({
      ...cliReading,
      usageMetadata: { source: 'oauth', attemptedSources: ['oauth'] }
    })

    const result = await fetchActiveClaudeRateLimits({
      ...profileOptions,
      allowUsagePanelSupplement: true,
      usageEndpointRetryAtMs: 1
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
      usageEndpointRetryAtMs: OPEN_ENDPOINT_GATE,
      signal: controller.signal
    })

    expect(result.error).toBe('Rate-limit fetch aborted')
    expect(fetchClaudeOAuthUsage).not.toHaveBeenCalled()
  })
})

describe('Claude usage when the endpoint cannot answer', () => {
  it('carries the refusal own Retry-After onto the probe reading', async () => {
    vi.mocked(fetchClaudeOAuthUsage).mockRejectedValueOnce(rateLimitedError(RETRY_AFTER_MS))
    vi.mocked(readClaudeUsageFromCli).mockResolvedValue(cliReading)

    const result = await fetchActiveClaudeRateLimits({
      ...profileOptions,
      allowUsagePanelSupplement: true
    })

    expect(result.session?.usedPercent).toBe(31)
    // Why: without this the next poll asks the endpoint again inside its own wait, which is what
    // keeps a 429 window alive.
    expect(result.usageMetadata?.retryAtMs).toBeGreaterThanOrEqual(Date.now() + RETRY_AFTER_MS - 1)
  })

  it('hands a settings-env login to the child, which cannot see the settings file itself', async () => {
    vi.mocked(readClaudeOAuthCredentials).mockResolvedValue({
      token: 'sk-ant-oat01-settings',
      hasRefreshableCredentials: false,
      source: 'settings-env'
    })
    vi.mocked(fetchClaudeOAuthUsage).mockRejectedValueOnce(rateLimitedError())
    vi.mocked(readClaudeUsageFromCli).mockResolvedValue(cliReading)

    await fetchActiveClaudeRateLimits({ ...profileOptions, allowUsagePanelSupplement: true })

    expect(vi.mocked(readClaudeUsageFromCli).mock.calls[0][0]?.oauthToken).toBe(
      'sk-ant-oat01-settings'
    )
  })

  it('spends no turn on a refusal a probe cannot outlast', async () => {
    vi.mocked(fetchClaudeOAuthUsage).mockRejectedValueOnce(
      new OAuthUsageError('This token lacks the user:profile scope.', 403, true, null)
    )
    vi.mocked(readClaudeUsageFromCli).mockResolvedValue(cliReading)

    const result = await fetchActiveClaudeRateLimits({
      ...profileOptions,
      allowUsagePanelSupplement: true
    })

    expect(readClaudeUsageFromCli).not.toHaveBeenCalled()
    expect(result.usageMetadata?.failureKind).toBe('missing-scope')
  })

  it('reaches the refresh on a refused token without spending a turn first', async () => {
    vi.mocked(fetchClaudeOAuthUsage)
      .mockRejectedValueOnce(new OAuthUsageError('Invalid OAuth token.', 401, true, null))
      .mockRejectedValueOnce(rateLimitedError(RETRY_AFTER_MS))
    vi.mocked(refreshClaudeOAuthCredentials).mockResolvedValue({
      status: 'refreshed',
      accessToken: 'sk-ant-oat01-refreshed',
      exchanged: false
    })
    vi.mocked(readClaudeUsageFromCli).mockResolvedValue(cliReading)

    const result = await fetchActiveClaudeRateLimits({
      ...profileOptions,
      allowUsagePanelSupplement: true
    })

    // Why: the refused token is never handed to the CLI, which prefers an env token over its own login.
    expect(readClaudeUsageFromCli).toHaveBeenCalledTimes(1)
    expect(vi.mocked(readClaudeUsageFromCli).mock.calls[0][0]?.oauthToken).toBeUndefined()
    expect(result.session?.usedPercent).toBe(31)
  })

  it('asks the endpoint first so a healthy one keeps the spend cap and credits it alone reports', async () => {
    vi.mocked(fetchClaudeOAuthUsage).mockResolvedValue({
      ...cliReading,
      usageMetadata: { source: 'oauth', attemptedSources: ['oauth'] }
    })

    const result = await fetchActiveClaudeRateLimits({
      ...profileOptions,
      allowUsagePanelSupplement: true
    })

    expect(fetchClaudeOAuthUsage).toHaveBeenCalledTimes(1)
    expect(readClaudeUsageFromCli).not.toHaveBeenCalled()
    expect(result.usageMetadata?.source).toBe('oauth')
  })
})
