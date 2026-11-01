import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchDeepInfraRateLimits } from './deepinfra/deepinfra-fetcher'
import { hasDeepInfraApiKey } from '../deepinfra/deepinfra-api-key-store'
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

vi.mock('./opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: vi.fn()
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

vi.mock('./deepinfra/deepinfra-fetcher', () => ({
  fetchDeepInfraRateLimits: vi.fn()
}))

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

vi.mock('../deepinfra/deepinfra-api-key-store', () => ({
  hasDeepInfraApiKey: vi.fn(() => false)
}))

vi.mock('./grok-fetcher', () => ({
  fetchGrokRateLimits: vi.fn()
}))

vi.mock('./grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))

vi.mock('./cursor-fetcher', () => ({
  fetchCursorRateLimits: vi.fn()
}))

vi.mock('./zcode-usage-fetcher', () => ({ fetchZcodeRateLimits: vi.fn() }))
vi.mock('./antigravity-usage-fetcher', () => ({ fetchAntigravityRateLimits: vi.fn() }))

vi.mock('./cursor-auth', () => ({
  readCursorAuthSession: vi.fn()
}))

vi.mock('../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

vi.mock('../minimax/minimax-api-key-store', () => ({
  hasMiniMaxApiKey: vi.fn(() => false)
}))

// Why: the shared fixture pins one amount, but the race tests must prove which fetch landed.
function creditsWithAmount(units: string): ProviderRateLimits {
  const snapshot = creditsProvider('deepinfra', 'balance')
  if (!snapshot.credits) {
    throw new Error('expected the credits fixture to carry a credits readout')
  }
  return {
    ...snapshot,
    credits: { ...snapshot.credits, amount: { ...snapshot.credits.amount, units } }
  }
}

describe('RateLimitService DeepInfra usage', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    // Why: these cases only stub DeepInfra, so the surrounding fetch cycle still
    // needs healthy Claude/Codex results.
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
  })

  it('fetches the DeepInfra balance and stores it under the deepinfra key', async () => {
    const service = new RateLimitService()
    service.setDeepInfraConfigResolver(() => ({ apiKey: 'sk-deepinfra-balance-key' }))
    vi.mocked(hasDeepInfraApiKey).mockReturnValue(true)
    vi.mocked(fetchDeepInfraRateLimits).mockResolvedValueOnce(
      creditsProvider('deepinfra', 'balance')
    )

    await service.refresh()

    expect(fetchDeepInfraRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchDeepInfraRateLimits).toHaveBeenCalledWith({ apiKey: 'sk-deepinfra-balance-key' })

    const state = service.getState()
    expect(state.deepinfra?.status).toBe('ok')
    expect(state.deepinfra?.provider).toBe('deepinfra')
    expect(state.deepinfra?.credits).toEqual({
      kind: 'balance',
      amount: { currencyCode: 'USD', units: '42', nanos: 100_000_000 }
    })
    expect(state.deepinfraApiKeyConfigured).toBe(true)
  })

  it('reports deepinfraApiKeyConfigured from the key store even without a resolver', () => {
    const service = new RateLimitService()
    vi.mocked(hasDeepInfraApiKey).mockReturnValue(true)

    expect(service.getState().deepinfraApiKeyConfigured).toBe(true)
    expect(service.getState().deepinfra).toBeNull()
  })

  it('keeps the credits-only balance visible through a transient failure', async () => {
    const service = new RateLimitService()
    service.setDeepInfraConfigResolver(() => ({ apiKey: 'sk-deepinfra-balance-key' }))
    vi.mocked(fetchDeepInfraRateLimits)
      .mockResolvedValueOnce(creditsProvider('deepinfra', 'balance'))
      .mockRejectedValueOnce(new Error('DeepInfra billing request failed: network timeout'))

    await service.refresh()
    expect(service.getState().deepinfra?.credits?.amount.units).toBe('42')

    await service.refresh()

    const state = service.getState()
    // Why: a balance has no quota window for the stale policy to test, so a
    // regression here blanks the status bar on any single transient error.
    expect(state.deepinfra?.status).toBe('error')
    expect(state.deepinfra?.error).toBe('DeepInfra billing request failed: network timeout')
    expect(state.deepinfra?.credits?.kind).toBe('balance')
    expect(state.deepinfra?.credits?.amount.units).toBe('42')
  })

  it('isolates a DeepInfra credential resolver failure from other providers', async () => {
    const service = new RateLimitService()
    service.setDeepInfraConfigResolver(() => {
      throw new Error('DeepInfra API key could not be decrypted')
    })
    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10))

    await service.refresh()

    const state = service.getState()
    expect(fetchDeepInfraRateLimits).not.toHaveBeenCalled()
    expect(state.deepinfra?.status).toBe('error')
    expect(state.deepinfra?.error).toBe('DeepInfra API key could not be decrypted')
    expect(state.deepinfra?.usageMetadata?.failureKind).toBe('keychain-unavailable')
    expect(state.deepinfra?.session).toBeNull()
    expect(state.claude?.status).toBe('ok')
    expect(state.claude?.session?.usedPercent).toBe(10)
  })

  it('clears the old balance when the API key changes', async () => {
    const service = new RateLimitService()
    let apiKey = 'sk-deepinfra-account-a'
    service.setDeepInfraConfigResolver(() => ({ apiKey }))
    const pending = deferred<ProviderRateLimits>()
    vi.mocked(fetchDeepInfraRateLimits)
      .mockResolvedValueOnce(creditsProvider('deepinfra', 'balance'))
      .mockImplementationOnce(() => pending.promise)

    await service.refresh()
    expect(service.getState().deepinfra?.credits?.amount.units).toBe('42')

    apiKey = 'sk-deepinfra-account-b'
    const secondRefresh = service.refresh()
    await flushMicrotasks()

    // Why: a new key must not keep showing the previous account's balance while its fetch is in flight.
    const pendingState = service.getState()
    expect(pendingState.deepinfra?.status).toBe('fetching')
    expect(pendingState.deepinfra?.credits).toBeUndefined()
    expect(fetchDeepInfraRateLimits).toHaveBeenLastCalledWith({ apiKey: 'sk-deepinfra-account-b' })

    pending.resolve(creditsProvider('deepinfra', 'balance'))
    await secondRefresh

    const state = service.getState()
    expect(fetchDeepInfraRateLimits).toHaveBeenCalledTimes(2)
    expect(state.deepinfra?.status).toBe('ok')
    expect(state.deepinfra?.credits?.amount.units).toBe('42')
  })

  it('does not apply an in-flight DeepInfra result after credential invalidation', async () => {
    const service = new RateLimitService()
    const firstDeepInfra = deferred<ProviderRateLimits>()
    const secondDeepInfra = deferred<ProviderRateLimits>()
    service.setDeepInfraConfigResolver(() => ({ apiKey: 'sk-deepinfra-balance-key' }))
    vi.mocked(fetchDeepInfraRateLimits)
      .mockImplementationOnce(() => firstDeepInfra.promise)
      .mockImplementationOnce(() => secondDeepInfra.promise)

    const firstRefresh = service.refresh()
    await flushMicrotasks()

    service.invalidateDeepInfraCredentialState()
    const queuedRefresh = service.refresh()
    await flushMicrotasks()

    firstDeepInfra.resolve(creditsWithAmount('42'))
    await flushMicrotasks()

    const staleState = service.getState()
    expect(staleState.deepinfra?.status).toBe('fetching')
    expect(staleState.deepinfra?.credits).toBeUndefined()

    secondDeepInfra.resolve(creditsWithAmount('7'))
    await Promise.all([firstRefresh, queuedRefresh])

    expect(service.getState().deepinfra?.credits?.amount.units).toBe('7')
  })

  it('never fetches a switched-off DeepInfra', async () => {
    const service = new RateLimitService({
      isUsageProviderDisabled: (providerId) => providerId === 'deepinfra'
    })
    service.setDeepInfraConfigResolver(() => ({ apiKey: 'sk-deepinfra-balance-key' }))

    await service.refresh()

    expect(fetchDeepInfraRateLimits).not.toHaveBeenCalled()
    expect(service.getState().deepinfra).toBeNull()
    expect(service.getState().deepinfraApiKeyConfigured).toBe(false)
  })
})
