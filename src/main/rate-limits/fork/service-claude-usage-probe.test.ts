import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import { RateLimitService } from '../service/rate-limit-service'
import { fetchActiveClaudeRateLimits } from '../providers/claude/claude-active-usage-fetch'
import {
  asRateLimitWindow,
  errorProvider,
  FakeRateLimitWindow,
  mockFreshBackgroundProviderFetches,
  okProvider,
  resetRateLimitProviderMocks
} from '../service/rate-limit-service-test-harness'

vi.mock('../providers/claude/claude-active-usage-fetch', () => ({
  fetchActiveClaudeRateLimits: vi.fn()
}))

vi.mock('../providers/claude/claude-managed-account-usage', () => ({
  fetchInactiveClaudeAccountUsage: vi.fn()
}))

vi.mock('../providers/codex/codex-fetcher', () => ({
  consumeCodexRateLimitResetCredit: vi.fn(),
  fetchCodexRateLimits: vi.fn()
}))
vi.mock('../providers/gemini/gemini-usage-fetcher', () => ({ fetchGeminiRateLimits: vi.fn() }))
vi.mock('../providers/kimi/kimi-fetcher', () => ({ fetchKimiRateLimits: vi.fn() }))
vi.mock('../providers/opencode-go/opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: vi.fn()
}))
vi.mock('../providers/zcode/zcode-usage-fetcher', () => ({ fetchZcodeRateLimits: vi.fn() }))
vi.mock('../providers/antigravity/antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
}))
vi.mock('../providers/muse/muse-usage-fetcher', () => ({ fetchMuseRateLimits: vi.fn() }))
vi.mock('../providers/minimax/minimax-fetcher', () => ({ fetchMiniMaxRateLimits: vi.fn() }))
vi.mock('../deepseek/deepseek-fetcher', () => ({ fetchDeepSeekRateLimits: vi.fn() }))
vi.mock('../fireworks/fireworks-fetcher', () => ({ fetchFireworksRateLimits: vi.fn() }))
vi.mock('../deepinfra/deepinfra-fetcher', () => ({ fetchDeepInfraRateLimits: vi.fn() }))
vi.mock('../copilot/copilot-fetcher', () => ({ fetchCopilotRateLimits: vi.fn() }))
vi.mock('../copilot/copilot-gh-credentials', () => ({
  resolveGhCopilotCredentials: vi.fn(async () => ({ status: 'gh-missing' })),
  refreshCopilotGhCredentials: vi.fn(async () => ({ status: 'gh-missing' })),
  readCopilotGhCredentialsForCycle: vi.fn(() => null),
  getCachedCopilotGhCredentials: vi.fn(() => null)
}))
vi.mock('../../../main/deepseek/deepseek-api-key-store', () => ({
  hasDeepSeekApiKey: vi.fn(() => false)
}))
vi.mock('../../../main/deepinfra/deepinfra-api-key-store', () => ({
  hasDeepInfraApiKey: vi.fn(() => false)
}))
vi.mock('../../../main/fireworks/fireworks-credentials-store', () => ({
  hasFireworksCredentials: vi.fn(() => false)
}))
vi.mock('../providers/grok/grok-fetcher', () => ({ fetchGrokRateLimits: vi.fn() }))
vi.mock('../providers/cursor/cursor-fetcher', () => ({ fetchCursorRateLimits: vi.fn() }))
vi.mock('../providers/cursor/cursor-auth', () => ({ readCursorAuthSession: vi.fn() }))
vi.mock('../providers/grok/grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))
vi.mock('../../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

function cliReading(usedPercent: number): ProviderRateLimits {
  return {
    ...okProvider('claude', usedPercent),
    weekly: { usedPercent: 44, windowMinutes: 10_080, resetsAt: null, resetDescription: null },
    usageMetadata: { source: 'cli', attemptedSources: ['cli'] }
  }
}

function rateLimited(retryAtMs = Date.now() + 60 * 60 * 1000): ProviderRateLimits {
  return {
    ...errorProvider('claude', 'Claude usage is rate limited right now.'),
    usageMetadata: { failureKind: 'rate-limited', retryAtMs }
  }
}

describe('Claude usage polling', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    mockFreshBackgroundProviderFetches()
  })

  it('refreshes Claude on activation while the endpoint Retry-After is still open', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchActiveClaudeRateLimits)
        .mockResolvedValueOnce(rateLimited())
        .mockResolvedValue(cliReading(31))

      const service = new RateLimitService()
      const window = new FakeRateLimitWindow()
      service.attach(asRateLimitWindow(window))
      service.start({ fetchImmediately: false })
      await vi.advanceTimersByTimeAsync(1000)

      expect(service.getState().claude?.status).toBe('error')
      expect(service.getState().claude?.usageMetadata?.retryAtMs).toBeGreaterThan(Date.now())

      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)

      // Why: the probe answers without the endpoint, so its Retry-After cannot freeze the lane.
      expect(fetchActiveClaudeRateLimits).toHaveBeenCalledTimes(2)
      expect(service.getState().claude?.status).toBe('ok')
      expect(service.getState().claude?.session?.usedPercent).toBe(31)
      expect(service.getState().claude?.usageMetadata?.source).toBe('cli')

      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('hands the open endpoint Retry-After to the next fetch instead of to the lane', async () => {
    vi.useFakeTimers()
    try {
      const retryAtMs = Date.now() + 40 * 60 * 1000
      vi.mocked(fetchActiveClaudeRateLimits)
        .mockResolvedValueOnce(rateLimited(retryAtMs))
        .mockResolvedValue(cliReading(12))

      const service = new RateLimitService()
      const window = new FakeRateLimitWindow()
      service.attach(asRateLimitWindow(window))
      service.start({ fetchImmediately: false })
      await vi.advanceTimersByTimeAsync(1000)

      expect(vi.mocked(fetchActiveClaudeRateLimits).mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          allowUsagePanelSupplement: true,
          usageEndpointRetryAtMs: null
        })
      )

      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)

      // Why the second call: with the probe in play the fetch must still be told the wait is open,
      // so a probe that cannot answer does not spend the request the endpoint refused.
      expect(vi.mocked(fetchActiveClaudeRateLimits).mock.calls[1]?.[0]).toEqual(
        expect.objectContaining({ usageEndpointRetryAtMs: retryAtMs })
      )

      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears that wait for a user refresh, the one call allowed to ask the endpoint', async () => {
    vi.useFakeTimers()
    try {
      const retryAtMs = Date.now() + 40 * 60 * 1000
      vi.mocked(fetchActiveClaudeRateLimits)
        .mockResolvedValueOnce(rateLimited(retryAtMs))
        .mockResolvedValue(cliReading(12))

      const service = new RateLimitService()
      await service.refresh()
      expect(service.getState().claude?.usageMetadata?.retryAtMs).toBe(retryAtMs)

      await service.refresh()
      expect(vi.mocked(fetchActiveClaudeRateLimits).mock.calls[1]?.[0]).toEqual(
        expect.objectContaining({ usageEndpointRetryAtMs: null })
      )

      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers on the next timer cycle after the endpoint rate limited the previous one', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchActiveClaudeRateLimits)
        .mockResolvedValueOnce(rateLimited())
        .mockResolvedValue(cliReading(27))

      const service = new RateLimitService()
      service.attach(asRateLimitWindow(new FakeRateLimitWindow()))
      service.start({ fetchImmediately: false })
      await vi.advanceTimersByTimeAsync(1000)
      expect(service.getState().claude?.status).toBe('error')

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000)

      expect(fetchActiveClaudeRateLimits).toHaveBeenCalledTimes(2)
      expect(service.getState().claude?.status).toBe('ok')
      expect(service.getState().claude?.session?.usedPercent).toBe(27)

      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('publishes a fresh reading on the poll cadence, not only after a session runs', async () => {
    vi.useFakeTimers()
    try {
      let checks = 0
      vi.mocked(fetchActiveClaudeRateLimits).mockImplementation(async () =>
        cliReading(++checks * 10)
      )

      const service = new RateLimitService()
      service.attach(asRateLimitWindow(new FakeRateLimitWindow()))
      service.start({ fetchImmediately: false })
      await vi.advanceTimersByTimeAsync(1000)
      expect(service.getState().claude?.session?.usedPercent).toBe(10)

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
      expect(fetchActiveClaudeRateLimits).toHaveBeenCalledTimes(2)
      expect(service.getState().claude?.session?.usedPercent).toBe(20)

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
      expect(service.getState().claude?.session?.usedPercent).toBe(30)

      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
