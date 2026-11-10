import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from '../service/rate-limit-service'
import { fetchActiveClaudeRateLimits } from '../providers/claude/claude-active-usage-fetch'
import {
  asRateLimitWindow,
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
vi.mock('../providers/muse/muse-usage-fetcher', () => ({ fetchMuseRateLimits: vi.fn() }))
vi.mock('../providers/kimi/kimi-fetcher', () => ({ fetchKimiRateLimits: vi.fn() }))
vi.mock('../providers/opencode-go/opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: vi.fn()
}))
vi.mock('../providers/zcode/zcode-usage-fetcher', () => ({ fetchZcodeRateLimits: vi.fn() }))
vi.mock('../providers/antigravity/antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
}))
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

/**
 * Upstream pauses the poll unless the window is visible, unminimized *and* focused. A serve-mode host
 * keeps its window hidden, so that rule left a remote host never polling usage at all — its numbers
 * only moved when a session posted a live receipt. The timer polls regardless; this pins it.
 */
describe('usage polling without a focused window', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    mockFreshBackgroundProviderFetches()
    vi.mocked(fetchActiveClaudeRateLimits).mockResolvedValue(okProvider('claude', 12))
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
      const afterStartup = vi.mocked(fetchActiveClaudeRateLimits).mock.calls.length
      expect(afterStartup).toBeGreaterThan(0)

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
      expect(vi.mocked(fetchActiveClaudeRateLimits).mock.calls.length).toBeGreaterThan(afterStartup)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops polling once the window is gone', async () => {
    vi.useFakeTimers()
    try {
      const service = new RateLimitService()
      service.start({ fetchImmediately: false })
      const before = vi.mocked(fetchActiveClaudeRateLimits).mock.calls.length

      await vi.advanceTimersByTimeAsync(45 * 60 * 1000)
      expect(vi.mocked(fetchActiveClaudeRateLimits).mock.calls.length).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })
})
