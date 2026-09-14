import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchFireworksRateLimits } from './fireworks/fireworks-fetcher'
import { hasFireworksCredentials } from '../fireworks/fireworks-credentials-store'
import {
  creditsProvider,
  deferred,
  flushMicrotasks,
  okProvider,
  resetRateLimitProviderMocks
} from './rate-limit-service-test-harness'

vi.mock('./claude-fetcher', () => ({
  fetchClaudeRateLimits: vi.fn(),
  fetchManagedAccountUsage: vi.fn()
}))

vi.mock('./codex-fetcher', () => ({
  consumeCodexRateLimitResetCredit: vi.fn(),
  fetchCodexRateLimits: vi.fn()
}))

vi.mock('./gemini-usage-fetcher', () => ({
  fetchGeminiRateLimits: vi.fn()
}))

vi.mock('./kimi-fetcher', () => ({
  fetchKimiRateLimits: vi.fn()
}))

vi.mock('./opencode-go-usage-fetcher', () => ({
  fetchOpenCodeGoRateLimits: vi.fn()
}))

vi.mock('./minimax/minimax-fetcher', () => ({
  fetchMiniMaxRateLimits: vi.fn()
}))

vi.mock('./deepseek/deepseek-fetcher', () => ({
  fetchDeepSeekRateLimits: vi.fn()
}))

vi.mock('./fireworks/fireworks-fetcher', () => ({
  fetchFireworksRateLimits: vi.fn()
}))

// Why: the Copilot provider probes the gh CLI during a fetch cycle. Without these two
// mocks every service suite would spawn real gh subprocesses, which is both slow and
// non-deterministic for the generation/invalidation races these suites assert.
vi.mock('./copilot/copilot-fetcher', () => ({
  fetchCopilotRateLimits: vi.fn()
}))

vi.mock('./copilot/copilot-gh-credentials', () => ({
  resolveGhCopilotCredentials: vi.fn(async () => ({ status: 'gh-missing' })),
  refreshCopilotGhCredentials: vi.fn(async () => ({ status: 'gh-missing' })),
  readCopilotGhCredentialsForCycle: vi.fn(() => null),
  getCachedCopilotGhCredentials: vi.fn(() => null)
}))

vi.mock('../deepseek/deepseek-api-key-store', () => ({
  hasDeepSeekApiKey: vi.fn(() => false)
}))

vi.mock('../fireworks/fireworks-credentials-store', () => ({
  hasFireworksCredentials: vi.fn(() => false)
}))

vi.mock('./grok-fetcher', () => ({
  fetchGrokRateLimits: vi.fn()
}))

vi.mock('./grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))

vi.mock('../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

vi.mock('../minimax/minimax-api-key-store', () => ({
  hasMiniMaxApiKey: vi.fn(() => false)
}))

// Why: the shared fixture pins one amount, but a race test must prove which fetch's value landed.
function creditsWithAmount(units: string): ProviderRateLimits {
  const snapshot = creditsProvider('fireworks', 'spend')
  if (!snapshot.credits) {
    throw new Error('expected the credits fixture to carry a credits readout')
  }
  return {
    ...snapshot,
    credits: { ...snapshot.credits, amount: { ...snapshot.credits.amount, units } }
  }
}

describe('RateLimitService Fireworks usage', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    // Why: these cases only stub Fireworks, so the surrounding fetch cycle still
    // needs healthy Claude/Codex results — previously inherited implicitly from
    // earlier tests' persistent mocks (clearAllMocks keeps implementations).
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
  })

  it('fetches the Fireworks spend and stores it under the fireworks key', async () => {
    const service = new RateLimitService()
    service.setFireworksConfigResolver(() => ({
      apiKey: 'fw-api-key-1234',
      accountIdOverride: null
    }))
    vi.mocked(hasFireworksCredentials).mockReturnValue(true)
    vi.mocked(fetchFireworksRateLimits).mockResolvedValueOnce(creditsProvider('fireworks', 'spend'))

    await service.refresh()

    expect(fetchFireworksRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchFireworksRateLimits).toHaveBeenCalledWith({
      apiKey: 'fw-api-key-1234',
      accountIdOverride: null
    })

    const state = service.getState()
    expect(state.fireworks?.status).toBe('ok')
    expect(state.fireworks?.provider).toBe('fireworks')
    expect(state.fireworks?.credits).toEqual({
      kind: 'spend',
      period: 'current-month',
      amount: { currencyCode: 'USD', units: '42', nanos: 100_000_000 }
    })
    expect(state.fireworksApiKeyConfigured).toBe(true)
  })

  it('reports fireworksApiKeyConfigured from the credentials store even without a resolver', () => {
    const service = new RateLimitService()
    vi.mocked(hasFireworksCredentials).mockReturnValue(true)

    expect(service.getState().fireworksApiKeyConfigured).toBe(true)
    expect(service.getState().fireworks).toBeNull()
  })

  it('keeps the credits-only spend visible through a transient failure', async () => {
    const service = new RateLimitService()
    service.setFireworksConfigResolver(() => ({
      apiKey: 'fw-api-key-1234',
      accountIdOverride: null
    }))
    vi.mocked(fetchFireworksRateLimits)
      .mockResolvedValueOnce(creditsProvider('fireworks', 'spend'))
      .mockRejectedValueOnce(new Error('Fireworks billing request failed: network timeout'))

    await service.refresh()
    expect(service.getState().fireworks?.credits?.amount.units).toBe('42')

    await service.refresh()

    const state = service.getState()
    // Why: billed spend has no quota window for the stale policy to test, so a
    // regression here blanks the status bar on any single transient error.
    expect(state.fireworks?.status).toBe('error')
    expect(state.fireworks?.error).toBe('Fireworks billing request failed: network timeout')
    expect(state.fireworks?.credits?.kind).toBe('spend')
    expect(state.fireworks?.credits?.period).toBe('current-month')
    expect(state.fireworks?.credits?.amount.currencyCode).toBe('USD')
    expect(state.fireworks?.credits?.amount.units).toBe('42')
    expect(state.fireworks?.credits?.amount.nanos).toBe(100_000_000)
  })

  it('isolates a Fireworks credential resolver failure from other providers', async () => {
    const service = new RateLimitService()
    service.setFireworksConfigResolver(() => {
      throw new Error('Fireworks credentials could not be decrypted')
    })
    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10))

    await service.refresh()

    const state = service.getState()
    expect(fetchFireworksRateLimits).not.toHaveBeenCalled()
    expect(state.fireworks?.status).toBe('error')
    expect(state.fireworks?.error).toBe('Fireworks credentials could not be decrypted')
    expect(state.fireworks?.usageMetadata?.failureKind).toBe('keychain-unavailable')
    expect(state.fireworks?.session).toBeNull()
    expect(state.claude?.status).toBe('ok')
    expect(state.claude?.session?.usedPercent).toBe(10)
  })

  it('clears the old spend when the API key changes', async () => {
    const service = new RateLimitService()
    let apiKey = 'fw-api-key-account-a'
    service.setFireworksConfigResolver(() => ({ apiKey, accountIdOverride: null }))
    const pending = deferred<ProviderRateLimits>()
    vi.mocked(fetchFireworksRateLimits)
      .mockResolvedValueOnce(creditsProvider('fireworks', 'spend'))
      .mockImplementationOnce(() => pending.promise)

    await service.refresh()
    expect(service.getState().fireworks?.credits?.amount.units).toBe('42')

    apiKey = 'fw-api-key-account-b'
    const secondRefresh = service.refresh()
    await flushMicrotasks()

    // Why: a new key must not keep showing the previous account's spend while its fetch is in flight.
    const pendingState = service.getState()
    expect(pendingState.fireworks?.status).toBe('fetching')
    expect(pendingState.fireworks?.credits).toBeUndefined()
    expect(fetchFireworksRateLimits).toHaveBeenLastCalledWith({
      apiKey: 'fw-api-key-account-b',
      accountIdOverride: null
    })

    pending.resolve(creditsProvider('fireworks', 'spend'))
    await secondRefresh

    const state = service.getState()
    expect(fetchFireworksRateLimits).toHaveBeenCalledTimes(2)
    expect(state.fireworks?.status).toBe('ok')
    expect(state.fireworks?.credits?.amount.units).toBe('42')
  })

  it('treats an accountIdOverride-only change as a config change', async () => {
    const service = new RateLimitService()
    let accountIdOverride: string | null = null
    service.setFireworksConfigResolver(() => ({ apiKey: 'fw-api-key-1234', accountIdOverride }))
    const pending = deferred<ProviderRateLimits>()
    vi.mocked(fetchFireworksRateLimits)
      .mockResolvedValueOnce(creditsProvider('fireworks', 'spend'))
      .mockImplementationOnce(() => pending.promise)

    await service.refresh()
    expect(service.getState().fireworks?.credits?.amount.units).toBe('42')

    // Why: same API key, but the config hash covers the override, so the old account's spend must not linger.
    accountIdOverride = 'acct-42'
    const secondRefresh = service.refresh()
    await flushMicrotasks()

    const pendingState = service.getState()
    expect(pendingState.fireworks?.status).toBe('fetching')
    expect(pendingState.fireworks?.credits).toBeUndefined()
    expect(fetchFireworksRateLimits).toHaveBeenLastCalledWith({
      apiKey: 'fw-api-key-1234',
      accountIdOverride: 'acct-42'
    })

    pending.resolve(creditsProvider('fireworks', 'spend'))
    await secondRefresh

    expect(fetchFireworksRateLimits).toHaveBeenCalledTimes(2)
    expect(service.getState().fireworks?.status).toBe('ok')
  })

  it('does not apply an in-flight Fireworks result after credential invalidation', async () => {
    const service = new RateLimitService()
    const firstFireworks = deferred<ProviderRateLimits>()
    const secondFireworks = deferred<ProviderRateLimits>()
    service.setFireworksConfigResolver(() => ({
      apiKey: 'fw-api-key-1234',
      accountIdOverride: null
    }))
    vi.mocked(fetchFireworksRateLimits)
      .mockImplementationOnce(() => firstFireworks.promise)
      .mockImplementationOnce(() => secondFireworks.promise)

    const firstRefresh = service.refresh()
    await flushMicrotasks()

    service.invalidateFireworksCredentialState()
    const queuedRefresh = service.refresh()
    await flushMicrotasks()

    firstFireworks.resolve(creditsWithAmount('42'))
    await flushMicrotasks()

    const staleState = service.getState()
    expect(staleState.fireworks?.status).toBe('fetching')
    expect(staleState.fireworks?.credits).toBeUndefined()

    secondFireworks.resolve(creditsWithAmount('7'))
    await firstRefresh
    await queuedRefresh

    const state = service.getState()
    expect(fetchFireworksRateLimits).toHaveBeenCalledTimes(2)
    expect(state.fireworks?.status).toBe('ok')
    expect(state.fireworks?.credits?.amount.units).toBe('7')
  })

  it('pushes a fetching snapshot as soon as the Fireworks credential is invalidated', async () => {
    const service = new RateLimitService()
    service.setFireworksConfigResolver(() => ({
      apiKey: 'fw-api-key-1234',
      accountIdOverride: null
    }))
    vi.mocked(fetchFireworksRateLimits).mockResolvedValueOnce(creditsProvider('fireworks', 'spend'))

    await service.refresh()
    expect(service.getState().fireworks?.status).toBe('ok')

    service.invalidateFireworksCredentialState()

    const state = service.getState()
    expect(state.fireworks?.status).toBe('fetching')
    expect(state.fireworks?.session).toBeNull()
    expect(state.fireworks?.weekly).toBeNull()
    expect(state.fireworks?.credits).toBeUndefined()
    expect(state.fireworks?.updatedAt).toBe(0)
  })
})
