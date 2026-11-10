import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import { RateLimitService } from './rate-limit-service'
import { fetchActiveClaudeRateLimits } from '../providers/claude/claude-active-usage-fetch'
import {
  consumeCodexRateLimitResetCredit,
  fetchCodexRateLimits
} from '../providers/codex/codex-fetcher'
import {
  deferred,
  okProvider,
  resetRateLimitProviderMocks
} from './rate-limit-service-test-harness'

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

vi.mock('../providers/gemini/gemini-usage-fetcher', () => ({
  fetchGeminiRateLimits: vi.fn()
}))

vi.mock('../providers/kimi/kimi-fetcher', () => ({
  fetchKimiRateLimits: vi.fn()
}))

vi.mock('../providers/opencode-go/opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: vi.fn()
}))

vi.mock('../providers/zcode/zcode-usage-fetcher', () => ({
  fetchZcodeRateLimits: vi.fn()
}))

vi.mock('../providers/muse/muse-usage-fetcher', () => ({
  fetchMuseRateLimits: vi.fn()
}))

vi.mock('../providers/antigravity/antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
}))

vi.mock('../providers/minimax/minimax-fetcher', () => ({
  fetchMiniMaxRateLimits: vi.fn()
}))

vi.mock('../deepseek/deepseek-fetcher', () => ({
  fetchDeepSeekRateLimits: vi.fn()
}))

vi.mock('../fireworks/fireworks-fetcher', () => ({
  fetchFireworksRateLimits: vi.fn()
}))

vi.mock('../deepinfra/deepinfra-fetcher', () => ({
  fetchDeepInfraRateLimits: vi.fn()
}))

// Why: the Copilot provider probes the gh CLI during a fetch cycle. Without these two
// mocks every service suite would spawn real gh subprocesses, which is both slow and
// non-deterministic for the generation/invalidation races these suites assert.
vi.mock('../copilot/copilot-fetcher', () => ({
  fetchCopilotRateLimits: vi.fn()
}))

vi.mock('../copilot/copilot-gh-credentials', () => ({
  resolveGhCopilotCredentials: vi.fn(async () => ({ status: 'gh-missing' })),
  refreshCopilotGhCredentials: vi.fn(async () => ({ status: 'gh-missing' })),
  readCopilotGhCredentialsForCycle: vi.fn(() => null),
  getCachedCopilotGhCredentials: vi.fn(() => null)
}))

vi.mock('../../deepseek/deepseek-api-key-store', () => ({
  hasDeepSeekApiKey: vi.fn(() => false)
}))
vi.mock('../../deepinfra/deepinfra-api-key-store', () => ({
  hasDeepInfraApiKey: vi.fn(() => false)
}))

vi.mock('../../fireworks/fireworks-credentials-store', () => ({
  hasFireworksCredentials: vi.fn(() => false)
}))

vi.mock('../providers/grok/grok-fetcher', () => ({
  fetchGrokRateLimits: vi.fn()
}))

vi.mock('../providers/cursor/cursor-fetcher', () => ({
  fetchCursorRateLimits: vi.fn()
}))

vi.mock('../providers/cursor/cursor-auth', () => ({
  readCursorAuthSession: vi.fn()
}))

vi.mock('../providers/grok/grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))

vi.mock('../../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

describe('RateLimitService', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
  })

  it('keeps the reset result scoped when the active target changes during its refresh', async () => {
    const service = new RateLimitService()
    const idempotencyKey = '33333333-3333-4333-8333-333333333333'
    const hostRefresh = deferred<ProviderRateLimits>()
    service.setCodexHomePathResolver((target) => ({
      kind: 'ready',
      codexHomePath: target?.runtime === 'wsl' ? '/tmp/wsl-selection' : '/tmp/approved-selection'
    }))
    vi.mocked(consumeCodexRateLimitResetCredit).mockResolvedValueOnce('reset')
    vi.mocked(fetchCodexRateLimits)
      .mockReturnValueOnce(hostRefresh.promise)
      .mockResolvedValueOnce(okProvider('codex', 73, Date.now()))

    const pendingReset = service.consumeCodexRateLimitResetCredit({
      idempotencyKey,
      target: { runtime: 'host', wslDistro: null },
      codexHomePath: '/tmp/approved-selection'
    })
    await vi.waitFor(() => expect(fetchCodexRateLimits).toHaveBeenCalledOnce())

    await service.refreshCodexForTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    hostRefresh.resolve(okProvider('codex', 0, Date.now()))

    await expect(pendingReset).resolves.toMatchObject({
      outcome: 'reset',
      state: {
        codexTarget: { runtime: 'host', wslDistro: null },
        codex: { session: { usedPercent: 0 } }
      }
    })
    expect(service.getState()).toMatchObject({
      codexTarget: { runtime: 'wsl', wslDistro: 'Ubuntu' },
      codex: { session: { usedPercent: 73 } }
    })
  })

  it('does not let an older full refresh overwrite the post-reset Codex state', async () => {
    const service = new RateLimitService()
    const slowClaude = deferred<ProviderRateLimits>()
    service.setCodexHomePathResolver(() => ({
      kind: 'ready',
      codexHomePath: '/tmp/approved-selection'
    }))
    vi.mocked(fetchActiveClaudeRateLimits).mockReturnValueOnce(slowClaude.promise)
    vi.mocked(fetchCodexRateLimits)
      .mockResolvedValueOnce(okProvider('codex', 100, Date.now()))
      .mockResolvedValueOnce(okProvider('codex', 0, Date.now()))
    vi.mocked(consumeCodexRateLimitResetCredit).mockResolvedValueOnce('reset')

    const olderRefresh = service.refresh()
    await vi.waitFor(() => expect(fetchCodexRateLimits).toHaveBeenCalledOnce())

    await service.consumeCodexRateLimitResetCredit({
      idempotencyKey: '44444444-4444-4444-8444-444444444444',
      target: { runtime: 'host', wslDistro: null },
      codexHomePath: '/tmp/approved-selection'
    })
    expect(service.getState().codex?.session?.usedPercent).toBe(0)

    slowClaude.resolve(okProvider('claude', 20, Date.now()))
    await olderRefresh

    expect(service.getState().codex?.session?.usedPercent).toBe(0)
  })

  it('refuses to redeem a Codex reset credit while Codex is switched off', async () => {
    const service = new RateLimitService({
      isUsageProviderDisabled: (providerId) => providerId === 'codex'
    })

    await expect(
      service.consumeCodexRateLimitResetCredit({
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
        target: { runtime: 'host', wslDistro: null },
        codexHomePath: '/tmp/codex-home'
      })
    ).rejects.toThrow(/disabled/i)
    expect(consumeCodexRateLimitResetCredit).not.toHaveBeenCalled()
    expect(fetchCodexRateLimits).not.toHaveBeenCalled()
  })
})
