import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import {
  mockFreshBackgroundProviderFetches,
  okProvider,
  resetRateLimitProviderMocks,
  errorProvider,
  FakeRateLimitWindow,
  asRateLimitWindow
} from './rate-limit-service-test-harness'
import { fetchCodexRateLimits } from './codex-fetcher'

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

vi.mock('./zcode-usage-fetcher', () => ({
  fetchZcodeRateLimits: vi.fn()
}))

vi.mock('./muse-usage-fetcher', () => ({
  fetchMuseRateLimits: vi.fn()
}))

vi.mock('./antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
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

vi.mock('./grok-fetcher', () => ({
  fetchGrokRateLimits: vi.fn()
}))

vi.mock('./cursor-fetcher', () => ({
  fetchCursorRateLimits: vi.fn()
}))

vi.mock('./cursor-auth', () => ({
  readCursorAuthSession: vi.fn()
}))

vi.mock('./grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))

vi.mock('../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

// Why: a platform without the CLI usage probe (win32) is paced by the endpoint's own Retry-After.
class EndpointOnlyClaudeService extends RateLimitService {
  protected override canRefreshThroughRetryAfter(): boolean {
    return false
  }
}

describe('RateLimitService', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
  })

  // #37256: a headless host has no window, so its only watchers are remote account streams.
  it('polls without a window only while a remote reader watches', async () => {
    vi.useFakeTimers()
    try {
      mockFreshBackgroundProviderFetches()
      vi.mocked(fetchClaudeRateLimits).mockImplementation(async () => okProvider('claude', 12))
      const service = new RateLimitService()
      service.start({ fetchImmediately: false })

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
      expect(fetchClaudeRateLimits).not.toHaveBeenCalled()

      const release = service.addUsageViewer()
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)

      release()
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)

      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits out Retry-After before automated Claude refetches, then recovers', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchClaudeRateLimits)
        .mockImplementationOnce(async () => ({
          ...errorProvider('claude', 'Claude usage is rate limited right now.'),
          usageMetadata: { failureKind: 'rate-limited', retryAtMs: Date.now() + 40 * 60 * 1000 }
        }))
        .mockImplementation(async () => okProvider('claude', 18))
      mockFreshBackgroundProviderFetches()

      const service = new EndpointOnlyClaudeService()
      const window = new FakeRateLimitWindow()
      service.attach(asRateLimitWindow(window))
      service.start({ fetchImmediately: false })

      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)

      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)

      // Poll cycles inside Retry-After may refresh siblings, never Claude.
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
      expect(vi.mocked(fetchCodexRateLimits).mock.calls.length).toBeGreaterThan(1)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)
      expect(service.getState().claude?.status).toBe('ok')

      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  // fork-comment-ok: switched-off providers are fork-only, so this regression has no upstream home.
  // #300: a switched-off slot is forced null on every push, which made every focus refetch everything.
  it('does not refetch every provider on focus while one provider is switched off', async () => {
    vi.useFakeTimers()
    try {
      mockFreshBackgroundProviderFetches()
      vi.mocked(fetchClaudeRateLimits).mockImplementation(async () => okProvider('claude', 12))
      const service = new RateLimitService({
        isUsageProviderDisabled: (providerId) => providerId === 'gemini'
      })
      const window = new FakeRateLimitWindow()
      service.attach(asRateLimitWindow(window))
      service.start({ fetchImmediately: false })

      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)

      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)

      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
