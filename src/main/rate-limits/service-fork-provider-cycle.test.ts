import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchDeepSeekRateLimits } from './deepseek/deepseek-fetcher'
import { fetchFireworksRateLimits } from './fireworks/fireworks-fetcher'
import { fetchCopilotRateLimits } from './copilot/copilot-fetcher'
import { readCopilotGhCredentialsForCycle } from './copilot/copilot-gh-credentials'
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

vi.mock('./cursor-fetcher', () => ({
  fetchCursorRateLimits: vi.fn()
}))

vi.mock('./cursor-auth', () => ({
  readCursorAuthSession: vi.fn()
}))

vi.mock('./zcode-usage-fetcher', () => ({ fetchZcodeRateLimits: vi.fn() }))
vi.mock('./antigravity-usage-fetcher', () => ({ fetchAntigravityRateLimits: vi.fn() }))

vi.mock('../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

vi.mock('../minimax/minimax-api-key-store', () => ({
  hasMiniMaxApiKey: vi.fn(() => false)
}))

describe('RateLimitService fork provider sibling cycle', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
  })

  it('settles the fork chips within the cycle instead of leaving them fetching', async () => {
    const service = new RateLimitService()
    service.setDeepSeekConfigResolver(() => ({ apiKey: 'sk-fork-cycle-key' }))
    const pendingDeepSeek = deferred<ProviderRateLimits>()
    vi.mocked(fetchDeepSeekRateLimits).mockImplementationOnce(() => pendingDeepSeek.promise)

    const cycle = service.refresh()
    await flushMicrotasks()

    expect(service.getState().deepseek?.status).toBe('fetching')

    pendingDeepSeek.resolve(creditsProvider('deepseek', 'balance'))
    await cycle

    const state = service.getState()
    expect(state.deepseek?.status).toBe('ok')
    expect(state.deepseek?.credits?.amount.units).toBe('42')
  })

  it('never reads a disabled fork provider credentials', async () => {
    const deepSeekResolver = vi.fn(() => ({ apiKey: 'sk-live' }))
    const fireworksResolver = vi.fn(() => ({ apiKey: 'fw-live', accountIdOverride: null }))
    const copilotResolver = vi.fn(() => ({ token: 'ghp_live', enterpriseSlug: '' }))
    const service = new RateLimitService({
      isUsageProviderDisabled: (providerId) =>
        providerId === 'deepseek' || providerId === 'fireworks' || providerId === 'copilot'
    })
    service.setDeepSeekConfigResolver(deepSeekResolver)
    service.setFireworksConfigResolver(fireworksResolver)
    service.setCopilotConfigResolver(copilotResolver)

    await service.refresh()

    expect(deepSeekResolver).not.toHaveBeenCalled()
    expect(fireworksResolver).not.toHaveBeenCalled()
    expect(copilotResolver).not.toHaveBeenCalled()
    expect(readCopilotGhCredentialsForCycle).not.toHaveBeenCalled()
    expect(fetchDeepSeekRateLimits).not.toHaveBeenCalled()
    expect(fetchFireworksRateLimits).not.toHaveBeenCalled()
    expect(fetchCopilotRateLimits).not.toHaveBeenCalled()
    expect(service.getState().deepseek).toBeNull()
    expect(service.getState().fireworks).toBeNull()
    expect(service.getState().copilot).toBeNull()
  })
})
