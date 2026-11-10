import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service/rate-limit-service'
import { fetchActiveClaudeRateLimits } from './providers/claude/claude-active-usage-fetch'
import { fetchCodexRateLimits } from './providers/codex/codex-fetcher'
import { fetchDeepSeekRateLimits } from './deepseek/deepseek-fetcher'
import { hasDeepSeekApiKey } from '../deepseek/deepseek-api-key-store'
import {
  creditsProvider,
  deferred,
  flushMicrotasks,
  okProvider,
  resetRateLimitProviderMocks
} from './service/rate-limit-service-test-harness'

vi.mock('./providers/claude/claude-active-usage-fetch', () => ({
  fetchActiveClaudeRateLimits: vi.fn()
}))

vi.mock('./providers/claude/claude-managed-account-usage', () => ({
  fetchInactiveClaudeAccountUsage: vi.fn()
}))

vi.mock('./providers/codex/codex-fetcher', () => ({
  consumeCodexRateLimitResetCredit: vi.fn(),
  fetchCodexRateLimits: vi.fn()
}))

vi.mock('./providers/gemini/gemini-usage-fetcher', () => ({
  fetchGeminiRateLimits: vi.fn()
}))

vi.mock('./providers/kimi/kimi-fetcher', () => ({
  fetchKimiRateLimits: vi.fn()
}))

// Why: upstream's #22182 moved the OpenCode Go entry point; mock the module the service calls.
vi.mock('./providers/opencode-go/opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: vi.fn()
}))

vi.mock('./providers/minimax/minimax-fetcher', () => ({
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
vi.mock('../deepinfra/deepinfra-api-key-store', () => ({
  hasDeepInfraApiKey: vi.fn(() => false)
}))

vi.mock('../fireworks/fireworks-credentials-store', () => ({
  hasFireworksCredentials: vi.fn(() => false)
}))

vi.mock('./providers/grok/grok-fetcher', () => ({
  fetchGrokRateLimits: vi.fn()
}))

vi.mock('./providers/grok/grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))

// Why: upstream added the Cursor provider; the shared harness resets every provider it knows.
vi.mock('./providers/cursor/cursor-fetcher', () => ({
  fetchCursorRateLimits: vi.fn()
}))

vi.mock('./providers/zcode/zcode-usage-fetcher', () => ({ fetchZcodeRateLimits: vi.fn() }))
vi.mock('./providers/antigravity/antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
}))
vi.mock('./providers/muse/muse-usage-fetcher', () => ({ fetchMuseRateLimits: vi.fn() }))

vi.mock('./providers/cursor/cursor-auth', () => ({
  readCursorAuthSession: vi.fn()
}))

vi.mock('../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

vi.mock('../minimax/minimax-api-key-store', () => ({
  hasMiniMaxApiKey: vi.fn(() => false)
}))

// Why: the shared fixture pins one amount, but a race test must prove which fetch's value landed.
function creditsWithAmount(units: string): ProviderRateLimits {
  const snapshot = creditsProvider('deepseek', 'balance')
  if (!snapshot.credits) {
    throw new Error('expected the credits fixture to carry a credits readout')
  }
  return {
    ...snapshot,
    credits: { ...snapshot.credits, amount: { ...snapshot.credits.amount, units } }
  }
}

describe('RateLimitService DeepSeek usage', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    // Why: these cases only stub DeepSeek, so the surrounding fetch cycle still
    // needs healthy Claude/Codex results — previously inherited implicitly from
    // earlier tests' persistent mocks (clearAllMocks keeps implementations).
    vi.mocked(fetchActiveClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
  })

  it('fetches the DeepSeek balance and stores it under the deepseek key', async () => {
    const service = new RateLimitService()
    service.setDeepSeekConfigResolver(() => ({ apiKey: 'sk-deepseek-balance-key' }))
    vi.mocked(hasDeepSeekApiKey).mockReturnValue(true)
    vi.mocked(fetchDeepSeekRateLimits).mockResolvedValueOnce(creditsProvider('deepseek', 'balance'))

    await service.refresh()

    expect(fetchDeepSeekRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchDeepSeekRateLimits).toHaveBeenCalledWith({
      apiKey: 'sk-deepseek-balance-key',
      signal: expect.any(AbortSignal)
    })

    const state = service.getState()
    expect(state.deepseek?.status).toBe('ok')
    expect(state.deepseek?.provider).toBe('deepseek')
    expect(state.deepseek?.credits).toEqual({
      kind: 'balance',
      amount: { currencyCode: 'USD', units: '42', nanos: 100_000_000 }
    })
    expect(state.deepseekApiKeyConfigured).toBe(true)
  })

  it('reports deepseekApiKeyConfigured from the key store even without a resolver', () => {
    const service = new RateLimitService()
    vi.mocked(hasDeepSeekApiKey).mockReturnValue(true)

    expect(service.getState().deepseekApiKeyConfigured).toBe(true)
    expect(service.getState().deepseek).toBeNull()
  })

  it('keeps the credits-only balance visible through a transient failure', async () => {
    const service = new RateLimitService()
    service.setDeepSeekConfigResolver(() => ({ apiKey: 'sk-deepseek-balance-key' }))
    vi.mocked(fetchDeepSeekRateLimits)
      .mockResolvedValueOnce(creditsProvider('deepseek', 'balance'))
      .mockRejectedValueOnce(new Error('DeepSeek balance request failed: network timeout'))

    await service.refresh()
    expect(service.getState().deepseek?.credits?.amount.units).toBe('42')

    await service.refresh()

    const state = service.getState()
    // Why: a balance has no quota window for the stale policy to test, so a
    // regression here blanks the status bar on any single transient error.
    expect(state.deepseek?.status).toBe('error')
    expect(state.deepseek?.error).toBe('DeepSeek balance request failed: network timeout')
    expect(state.deepseek?.credits?.kind).toBe('balance')
    expect(state.deepseek?.credits?.amount.currencyCode).toBe('USD')
    expect(state.deepseek?.credits?.amount.units).toBe('42')
    expect(state.deepseek?.credits?.amount.nanos).toBe(100_000_000)
  })

  it('isolates a DeepSeek credential resolver failure from other providers', async () => {
    const service = new RateLimitService()
    service.setDeepSeekConfigResolver(() => {
      throw new Error('DeepSeek API key could not be decrypted')
    })
    vi.mocked(fetchActiveClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10))

    await service.refresh()

    const state = service.getState()
    expect(fetchDeepSeekRateLimits).not.toHaveBeenCalled()
    expect(state.deepseek?.status).toBe('error')
    expect(state.deepseek?.error).toBe('DeepSeek API key could not be decrypted')
    expect(state.deepseek?.usageMetadata?.failureKind).toBe('keychain-unavailable')
    expect(state.deepseek?.session).toBeNull()
    expect(state.claude?.status).toBe('ok')
    expect(state.claude?.session?.usedPercent).toBe(10)
  })

  it('clears the old balance when the API key changes', async () => {
    const service = new RateLimitService()
    let apiKey = 'sk-deepseek-account-a'
    service.setDeepSeekConfigResolver(() => ({ apiKey }))
    const pending = deferred<ProviderRateLimits>()
    vi.mocked(fetchDeepSeekRateLimits)
      .mockResolvedValueOnce(creditsProvider('deepseek', 'balance'))
      .mockImplementationOnce(() => pending.promise)

    await service.refresh()
    expect(service.getState().deepseek?.credits?.amount.units).toBe('42')

    apiKey = 'sk-deepseek-account-b'
    const secondRefresh = service.refresh()
    await flushMicrotasks()

    // Why: a new key must not keep showing the previous account's balance while its fetch is in flight.
    const pendingState = service.getState()
    expect(pendingState.deepseek?.status).toBe('fetching')
    expect(pendingState.deepseek?.credits).toBeUndefined()
    expect(fetchDeepSeekRateLimits).toHaveBeenLastCalledWith({
      apiKey: 'sk-deepseek-account-b',
      signal: expect.any(AbortSignal)
    })

    pending.resolve(creditsProvider('deepseek', 'balance'))
    await secondRefresh

    const state = service.getState()
    expect(fetchDeepSeekRateLimits).toHaveBeenCalledTimes(2)
    expect(state.deepseek?.status).toBe('ok')
    expect(state.deepseek?.credits?.amount.units).toBe('42')
  })

  it('does not apply an in-flight DeepSeek result after credential invalidation', async () => {
    const service = new RateLimitService()
    const firstDeepSeek = deferred<ProviderRateLimits>()
    const secondDeepSeek = deferred<ProviderRateLimits>()
    service.setDeepSeekConfigResolver(() => ({ apiKey: 'sk-deepseek-balance-key' }))
    vi.mocked(fetchDeepSeekRateLimits)
      .mockImplementationOnce(() => firstDeepSeek.promise)
      .mockImplementationOnce(() => secondDeepSeek.promise)

    const firstRefresh = service.refresh()
    await flushMicrotasks()

    service.invalidateDeepSeekCredentialState()
    const queuedRefresh = service.refresh()
    await flushMicrotasks()

    firstDeepSeek.resolve(creditsWithAmount('42'))
    await flushMicrotasks()

    const staleState = service.getState()
    expect(staleState.deepseek?.status).toBe('fetching')
    expect(staleState.deepseek?.credits).toBeUndefined()

    secondDeepSeek.resolve(creditsWithAmount('7'))
    await firstRefresh
    await queuedRefresh

    const state = service.getState()
    expect(fetchDeepSeekRateLimits).toHaveBeenCalledTimes(2)
    expect(state.deepseek?.status).toBe('ok')
    expect(state.deepseek?.credits?.amount.units).toBe('7')
  })

  it('pushes a fetching snapshot as soon as the DeepSeek credential is invalidated', async () => {
    const service = new RateLimitService()
    service.setDeepSeekConfigResolver(() => ({ apiKey: 'sk-deepseek-balance-key' }))
    vi.mocked(fetchDeepSeekRateLimits).mockResolvedValueOnce(creditsProvider('deepseek', 'balance'))

    await service.refresh()
    expect(service.getState().deepseek?.status).toBe('ok')

    service.invalidateDeepSeekCredentialState()

    const state = service.getState()
    expect(state.deepseek?.status).toBe('fetching')
    expect(state.deepseek?.session).toBeNull()
    expect(state.deepseek?.weekly).toBeNull()
    expect(state.deepseek?.credits).toBeUndefined()
    expect(state.deepseek?.updatedAt).toBe(0)
  })
})
