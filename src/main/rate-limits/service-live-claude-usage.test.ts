import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import {
  deferred,
  errorProvider,
  flushMicrotasks,
  mockFreshBackgroundProviderFetches,
  okProvider,
  resetRateLimitProviderMocks,
  asRateLimitWindow,
  FakeRateLimitWindow
} from './rate-limit-service-test-harness'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'

class ObservedRateLimitService extends RateLimitService {
  get claudeCheckCompletedAt(): number | null {
    return this.lastClaudeCheckCompletedAt
  }

  get activeRefreshPlan() {
    return this.getActiveWindowRefreshPlan(Date.now())
  }
}

// Why: a platform without the CLI usage probe (win32) is paced by the endpoint's own Retry-After.
class EndpointOnlyClaudeService extends ObservedRateLimitService {
  protected override canRefreshThroughRetryAfter(): boolean {
    return false
  }
}

const profileRouter = vi.hoisted((): { userConfigDir?: string } => ({}))
vi.mock('../claude-accounts/claude-profile-installed-router', () => ({
  getClaudeProfileRouter: () =>
    profileRouter.userConfigDir ? { userConfigDir: () => profileRouter.userConfigDir } : undefined
}))

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

describe('RateLimitService', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
  })

  it('honours a Retry-After that lands while the live feed is fresh', async () => {
    vi.useFakeTimers()
    try {
      const withFable: ProviderRateLimits = {
        ...okProvider('claude', 40),
        fableWeekly: {
          usedPercent: 18,
          windowMinutes: 10080,
          resetsAt: null,
          resetDescription: null
        }
      }
      vi.mocked(fetchClaudeRateLimits)
        .mockImplementationOnce(async () => withFable)
        .mockImplementation(async () => ({
          ...errorProvider('claude', 'Claude usage is rate limited right now.'),
          usageMetadata: { failureKind: 'rate-limited', retryAtMs: Date.now() + 60 * 60 * 1000 }
        }))
      mockFreshBackgroundProviderFetches()

      const service = new EndpointOnlyClaudeService()
      service.attach(asRateLimitWindow(new FakeRateLimitWindow()))
      service.start({ fetchImmediately: false })
      await vi.advanceTimersByTimeAsync(1000)

      // Live posts must not prevent the Fable poll from applying a one-hour 429 gate.
      for (let minute = 0; minute < 60; minute += 1) {
        service.ingestLiveClaudeRateLimits({
          configDir: null,
          fiveHour: { used_percentage: 40 + minute * 0.5 },
          sevenDay: { used_percentage: 30 }
        })
        await vi.advanceTimersByTimeAsync(60 * 1000)
      }

      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)
      expect(service.getState().claude?.status).toBe('ok')
      expect(service.getState().claude?.session?.usedPercent).toBe(69.5)

      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a Retry-After window closed after a live post clears the error', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchClaudeRateLimits).mockImplementation(async () => ({
        ...errorProvider('claude', 'Claude usage is rate limited right now.'),
        usageMetadata: { failureKind: 'rate-limited', retryAtMs: Date.now() + 50 * 60 * 1000 }
      }))
      mockFreshBackgroundProviderFetches()

      const service = new EndpointOnlyClaudeService()
      service.attach(asRateLimitWindow(new FakeRateLimitWindow()))
      service.start({ fetchImmediately: false })
      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)

      service.ingestLiveClaudeRateLimits({
        configDir: null,
        fiveHour: { used_percentage: 23.5 },
        sevenDay: { used_percentage: 41.2 }
      })
      expect(service.getState().claude?.status).toBe('ok')

      // Even stale live display must respect OAuth Retry-After.
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)

      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops statusline posts before attribution is known or from a mismatched config dir', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 18))
      mockFreshBackgroundProviderFetches()

      const service = new RateLimitService()

      // No cycle has established selected-account attribution yet.
      service.ingestLiveClaudeRateLimits({
        configDir: null,
        fiveHour: { used_percentage: 50 },
        sevenDay: null
      })
      expect(service.getState().claude).toBeNull()

      await service.refresh()
      expect(service.getState().claude?.session?.usedPercent).toBe(18)

      service.ingestLiveClaudeRateLimits({
        configDir: '/some/managed/dir',
        fiveHour: { used_percentage: 99 },
        sevenDay: null
      })
      expect(service.getState().claude?.session?.usedPercent).toBe(18)

      service.ingestLiveClaudeRateLimits({
        configDir: null,
        fiveHour: { used_percentage: 33 },
        sevenDay: null
      })
      expect(service.getState().claude?.session?.usedPercent).toBe(33)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['focus', 'mobile'])('paces %s checks by completion', async (trigger) => {
    vi.useFakeTimers()
    try {
      const parkedClaudeFetch = deferred<ProviderRateLimits>()
      vi.mocked(fetchClaudeRateLimits)
        .mockImplementationOnce(async () => okProvider('claude', 18))
        .mockImplementationOnce(() => parkedClaudeFetch.promise)
        .mockImplementation(async () => okProvider('claude', 8))
      mockFreshBackgroundProviderFetches()
      const service = new EndpointOnlyClaudeService()
      const window = new FakeRateLimitWindow()
      service.attach(asRateLimitWindow(window))
      const activate = async () => {
        if (trigger === 'mobile') {
          await service.refreshIfStale()
        } else {
          window.emit('focus')
        }
        await vi.advanceTimersByTimeAsync(0)
      }
      await service.refresh()
      await vi.advanceTimersByTimeAsync(60 * 1000)
      const secondRefresh = service.refresh()
      await flushMicrotasks()
      service.ingestLiveClaudeRateLimits({
        configDir: null,
        fiveHour: { used_percentage: 41 },
        sevenDay: null
      })
      await vi.advanceTimersByTimeAsync(60 * 1000)
      const completedAt = Date.now()
      const retryAtMs = completedAt + 4.5 * 60 * 1000
      parkedClaudeFetch.resolve({
        ...errorProvider('claude', 'rate limited'),
        usageMetadata: { failureKind: 'rate-limited', retryAtMs }
      })
      await secondRefresh
      expect(service.getState().claude?.session?.usedPercent).toBe(41)
      expect(service.getState().claude?.status).toBe('ok')
      expect(service.getState().claude?.usageMetadata?.retryAtMs).toBe(retryAtMs)
      expect(service.claudeCheckCompletedAt).toBe(completedAt)
      await service.refreshIfStale()
      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)

      // Sibling full cycles must not advance Claude's gated check clock.
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000)
      await service.refreshIfStale()
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(3)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)
      expect(service.claudeCheckCompletedAt).toBe(completedAt)
      await vi.advanceTimersByTimeAsync(60 * 1000 - 1)
      service.ingestLiveClaudeRateLimits({
        configDir: null,
        fiveHour: { used_percentage: 41 },
        sevenDay: null
      })
      await service.refreshIfStale()
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      await activate()
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(3)
      expect(service.getState().claude?.session?.usedPercent).toBe(8)
      await service.refreshIfStale()
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(3)

      // Repeated failure must remain gated beyond ordinary check age.
      const cooldownFetch = deferred<ProviderRateLimits>()
      vi.mocked(fetchClaudeRateLimits).mockImplementationOnce(() => cooldownFetch.promise)
      const cooldownRefresh = service.refresh()
      await flushMicrotasks()
      const postLive = () =>
        service.ingestLiveClaudeRateLimits({
          configDir: null,
          fiveHour: { used_percentage: 41 },
          sevenDay: null
        })
      postLive()
      await vi.advanceTimersByTimeAsync(60 * 1000)
      const cooldownCompletedAt = Date.now()
      const cooldownRetryAtMs = cooldownCompletedAt + 60 * 60 * 1000
      cooldownFetch.resolve({
        ...errorProvider('claude', 'rate limited'),
        usageMetadata: { failureKind: 'rate-limited', retryAtMs: cooldownRetryAtMs }
      })
      await cooldownRefresh
      expect(service.claudeCheckCompletedAt).toBe(cooldownCompletedAt)
      expect(service.getState().claude?.status).toBe('ok')
      expect(service.getState().claude?.usageMetadata?.retryAtMs).toBe(cooldownRetryAtMs)
      const siblingCallsBefore = vi.mocked(fetchCodexRateLimits).mock.calls.length
      // Sibling refreshes during cooldown must leave Claude's check clock alone.
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000)
      await activate()
      const siblingCalls = siblingCallsBefore + 1
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(siblingCalls)
      await vi.advanceTimersByTimeAsync(60 * 1000)
      for (let event = 0; event < 3; event += 1) {
        await vi.advanceTimersByTimeAsync(60 * 1000)
        postLive()
        const live = service.getState().claude
        await activate()
        expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(4)
        expect(fetchCodexRateLimits).toHaveBeenCalledTimes(siblingCalls)
        expect(fetchGeminiRateLimits).toHaveBeenCalledTimes(siblingCalls)
        expect(service.claudeCheckCompletedAt).toBe(cooldownCompletedAt)
        expect(service.getState().claude).toEqual(live)
      }
      await vi.advanceTimersByTimeAsync(60 * 1000)
      await activate()
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(siblingCalls + 1)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(4)
      // Freshen siblings so only Claude is due at the deadline.
      await vi.advanceTimersByTimeAsync(cooldownRetryAtMs - Date.now() - 1)
      postLive()
      await activate()
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(siblingCalls + 2)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(4)
      expect(service.claudeCheckCompletedAt).toBe(cooldownCompletedAt)
      await vi.advanceTimersByTimeAsync(1)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(4)
      await activate()
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(5)
      expect(service.getState().claude?.session?.usedPercent).toBe(8)
      expect(service.claudeCheckCompletedAt).toBe(cooldownRetryAtMs)
      await activate()
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(5)
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(siblingCalls + 3)
      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['full', 'claude-only'])('isolates %s checks on switch', async (cycle) => {
    vi.useFakeTimers()
    try {
      const staleClaudeFetch = deferred<ProviderRateLimits>()
      const incomingFetch = deferred<ProviderRateLimits>()
      vi.mocked(fetchClaudeRateLimits)
        .mockImplementationOnce(async () => okProvider('claude', 9))
        .mockImplementationOnce(() => staleClaudeFetch.promise)
        .mockImplementationOnce(() => incomingFetch.promise)
      mockFreshBackgroundProviderFetches()

      const authGate = deferred<void>()
      let resolverCalls = 0
      const service = new ObservedRateLimitService()
      await service.refresh()
      expect(service.claudeCheckCompletedAt).toBe(Date.now())
      service.setClaudeAuthPreparationResolver(async () => {
        resolverCalls += 1
        const outgoing = resolverCalls === 1
        if (outgoing) {
          await authGate.promise
        }
        return {
          configDir: outgoing ? '/outgoing/.claude' : '/incoming/.claude',
          runtime: 'host',
          wslDistro: null,
          wslLinuxConfigDir: null,
          envPatch: {
            CLAUDE_CONFIG_DIR: outgoing ? '/outgoing/.claude' : '/incoming/.claude'
          },
          provenance: outgoing ? 'managed:outgoing' : 'managed:incoming'
        }
      })

      // Switch while the outgoing account resolver is suspended.
      const firstRefresh = cycle === 'full' ? service.refresh() : service.refreshClaudeForTarget()
      await flushMicrotasks()
      const switchPromise =
        cycle === 'full'
          ? service.refreshForClaudeAccountChange('outgoing-account')
          : service.refreshClaudeForTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })
      await flushMicrotasks()
      authGate.resolve()
      await flushMicrotasks(8)

      // The stale resumed cycle must not authorize outgoing live posts on the new account.
      const beforeOutgoingPost = service.getState().claude?.session?.usedPercent
      service.ingestLiveClaudeRateLimits({
        configDir: '/outgoing/.claude',
        fiveHour: { used_percentage: 99 },
        sevenDay: null
      })
      expect(service.getState().claude?.session?.usedPercent).toBe(beforeOutgoingPost)

      staleClaudeFetch.resolve(okProvider('claude', 18))
      await vi.advanceTimersByTimeAsync(0)
      expect(service.claudeCheckCompletedAt).toBeNull()

      service.ingestLiveClaudeRateLimits({
        configDir: '/incoming/.claude',
        fiveHour: { used_percentage: 55 },
        sevenDay: null
      })
      expect(service.getState().claude?.session?.usedPercent).toBe(55)
      expect(service.activeRefreshPlan).toEqual({ kind: 'full' })
      incomingFetch.resolve(okProvider('claude', 18))
      await Promise.all([firstRefresh, switchPromise])
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(3)
      expect(service.claudeCheckCompletedAt).toBe(Date.now())
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the newer weekly value when an idle session re-posts an older one for the same window', async () => {
    vi.useFakeTimers()
    try {
      // OAuth and statusline reset timestamps differ in precision.
      const sessionReset = Date.now() + 128 * 60 * 1000 + 123
      const weeklyReset = Date.now() + 125 * 60 * 60 * 1000 + 456
      const win = (usedPercent: number, resetsAt: number, windowMinutes: number) => ({
        usedPercent,
        windowMinutes,
        resetsAt,
        resetDescription: null
      })
      vi.mocked(fetchClaudeRateLimits).mockResolvedValue({
        ...okProvider('claude', 10),
        session: win(10, sessionReset, 300),
        weekly: win(25, weeklyReset, 10080)
      })
      mockFreshBackgroundProviderFetches()
      const service = new RateLimitService()
      await service.refresh()
      const fetched = service.getState().claude
      const post = (session: number | null, weekly: number, weeklyResetAt = weeklyReset) =>
        service.ingestLiveClaudeRateLimits({
          configDir: null,
          fiveHour:
            session === null
              ? null
              : { used_percentage: session, resets_at: Math.floor(sessionReset / 1000) },
          sevenDay: { used_percentage: weekly, resets_at: Math.floor(weeklyResetAt / 1000) }
        })

      // Idle sessions can drop the expired 5h window while repeating stale weekly data; discard the whole stale post.
      await vi.advanceTimersByTimeAsync(60 * 1000)
      post(null, 8)
      expect(service.getState().claude).toEqual(fetched)

      post(10, 8)
      expect(service.getState().claude).toEqual(fetched)
      post(null, 90, weeklyReset - 7 * 24 * 60 * 60 * 1000)
      expect(service.getState().claude).toEqual(fetched)
      vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce({
        ...errorProvider('claude', 'rate limited'),
        usageMetadata: { retryAtMs: Date.now() + 60 * 60 * 1000, failureKind: 'rate-limited' }
      })
      await service.refresh()
      const failed = service.getState().claude
      post(10, 8)
      expect(service.getState().claude).toEqual(failed)
      post(10, 25)
      expect(service.getState().claude?.session?.resetsAt).toBe(sessionReset)
      expect(service.getState().claude?.status).toBe('ok')
      expect(service.getState().claude?.usageMetadata?.retryAtMs).toBe(
        failed?.usageMetadata?.retryAtMs
      )
      post(11, 25)
      expect(service.getState().claude?.weekly?.resetsAt).toBe(weeklyReset)
      const grownSessionReset = service.getState().claude?.session?.resetsAt
      post(11, 26)
      expect(service.getState().claude?.session?.resetsAt).toBe(grownSessionReset)
      expect(service.getState().claude?.weekly?.usedPercent).toBe(26)

      post(null, 1, weeklyReset + 7 * 24 * 60 * 60 * 1000)
      expect(service.getState().claude?.weekly?.usedPercent).toBe(1)
      service.ingestLiveClaudeRateLimits({
        configDir: null,
        fiveHour: null,
        sevenDay: { utilization: 0 }
      })
      expect(service.getState().claude?.weekly?.usedPercent).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
