import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from '../service'
import { fetchClaudeRateLimits } from '../claude-fetcher'
import {
  asRateLimitWindow,
  FakeRateLimitWindow,
  mockFreshBackgroundProviderFetches,
  okProvider,
  resetRateLimitProviderMocks
} from '../rate-limit-service-test-harness'

vi.mock('../claude-fetcher', () => ({
  fetchClaudeRateLimits: vi.fn(),
  fetchManagedAccountUsage: vi.fn()
}))
vi.mock('../codex-fetcher', () => ({
  consumeCodexRateLimitResetCredit: vi.fn(),
  fetchCodexRateLimits: vi.fn()
}))
vi.mock('../gemini-usage-fetcher', () => ({ fetchGeminiRateLimits: vi.fn() }))
vi.mock('../muse-usage-fetcher', () => ({ fetchMuseRateLimits: vi.fn() }))
vi.mock('../kimi-fetcher', () => ({ fetchKimiRateLimits: vi.fn() }))
vi.mock('../opencode-go-usage-source-selection', () => ({ fetchOpenCodeGoUsage: vi.fn() }))
vi.mock('../zcode-usage-fetcher', () => ({ fetchZcodeRateLimits: vi.fn() }))
vi.mock('../antigravity-usage-fetcher', () => ({ fetchAntigravityRateLimits: vi.fn() }))
vi.mock('../minimax/minimax-fetcher', () => ({ fetchMiniMaxRateLimits: vi.fn() }))
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
vi.mock('../grok-fetcher', () => ({ fetchGrokRateLimits: vi.fn() }))
vi.mock('../cursor-fetcher', () => ({ fetchCursorRateLimits: vi.fn() }))
vi.mock('../cursor-auth', () => ({ readCursorAuthSession: vi.fn() }))
vi.mock('../grok-auth', () => ({ readGrokAuthSession: vi.fn(() => ({ status: 'missing' })) }))
vi.mock('../../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

/**
 * Upstream pauses the poll unless the window is visible, unminimized *and* focused. A serve-mode host
 * keeps its window hidden, so that rule left a remote host never polling usage at all — its numbers
 * only moved when a session posted a live receipt. The timer polls regardless; this pins it.
 */
describe('usage polling without a focused window', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    mockFreshBackgroundProviderFetches()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 12))
  })

  it('polls on the timer while the window is unfocused, hidden and minimized', async () => {
    vi.useFakeTimers()
    try {
      const service = new RateLimitService()
      const window = new FakeRateLimitWindow()
      window.focused = false
      window.visible = false
      window.minimized = true
      service.attach(asRateLimitWindow(window))
      service.start({ fetchImmediately: false })

      await vi.advanceTimersByTimeAsync(60 * 1000)
      const afterStartup = vi.mocked(fetchClaudeRateLimits).mock.calls.length
      expect(afterStartup).toBeGreaterThan(0)

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
      expect(vi.mocked(fetchClaudeRateLimits).mock.calls.length).toBeGreaterThan(afterStartup)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops polling once the window is gone', async () => {
    vi.useFakeTimers()
    try {
      const service = new RateLimitService()
      service.start({ fetchImmediately: false })
      const before = vi.mocked(fetchClaudeRateLimits).mock.calls.length

      await vi.advanceTimersByTimeAsync(45 * 60 * 1000)
      expect(vi.mocked(fetchClaudeRateLimits).mock.calls.length).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })
})
