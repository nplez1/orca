import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchZcodeRateLimits } from './zcode-usage-fetcher'
import { fetchAntigravityRateLimits } from './antigravity-usage-fetcher'
import { fetchCursorRateLimits } from './cursor-fetcher'
import { readCursorAuthSession } from './cursor-auth'
import { fetchOpenCodeGoUsage } from './opencode-go-usage-source-selection'
import {
  errorProvider,
  okProvider,
  resetRateLimitProviderMocks
} from './rate-limit-service-test-harness'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
import { readGrokAuthSession } from './grok-auth'
import { fetchKimiRateLimits } from './kimi-fetcher'
import { fetchMuseRateLimits } from './muse-usage-fetcher'

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
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 0, 1_000))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 0, 1_000))
  })

  it('does not keep a previous ZCode account quota after a failed account switch', async () => {
    vi.mocked(fetchZcodeRateLimits)
      .mockResolvedValueOnce({
        ...okProvider('zcode', 42),
        usageMetadata: { source: 'web', authProvenance: 'account-a' }
      })
      .mockResolvedValueOnce({
        ...errorProvider('zcode', 'request failed'),
        usageMetadata: { source: 'web', authProvenance: 'account-b', failureKind: 'network' }
      })
    const service = new RateLimitService()

    await service.refresh()
    await service.refresh()

    expect(service.getState().zcode?.status).toBe('error')
    expect(service.getState().zcode?.session).toBeNull()
  })

  it('discards stale data when Workspace ID override is changed', async () => {
    const service = new RateLimitService()
    let workspaceId = 'wrk_A'
    service.setOpenCodeGoConfigResolver(() => ({
      sessionCookie: 'session=valid',
      workspaceIdOverride: workspaceId
    }))

    vi.mocked(fetchOpenCodeGoUsage).mockResolvedValue(okProvider('opencode-go', 40, Date.now()))
    await service.refresh()
    expect(service.getState().opencodeGo?.session?.usedPercent).toBe(40)

    workspaceId = 'wrk_B'
    vi.mocked(fetchOpenCodeGoUsage).mockResolvedValue(okProvider('opencode-go', 10, Date.now()))
    await service.refresh()
    expect(service.getState().opencodeGo?.session?.usedPercent).toBe(10)

    // Switching to automatic mode must discard workspace B's data even if the first refresh fails.
    workspaceId = ''
    vi.mocked(fetchOpenCodeGoUsage).mockResolvedValue({
      provider: 'opencode-go',
      session: null,
      weekly: null,
      monthly: null,
      updatedAt: Date.now(),
      error: 'No workspace ID found',
      status: 'error'
    })
    await service.refresh()
    const state = service.getState()
    expect(state.opencodeGo?.status).toBe('error')
    expect(state.opencodeGo?.session).toBeNull()
    expect(state.opencodeGo?.error).toBe('No workspace ID found')
  })
})

describe('disabled usage providers', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
  })

  it('never reads credentials for a switched-off provider', async () => {
    const service = new RateLimitService({
      isUsageProviderDisabled: (providerId) => providerId === 'gemini' || providerId === 'cursor'
    })

    await service.refresh()

    // Why: the fetcher short-circuits on the disabled flag before touching any OAuth source.
    expect(fetchGeminiRateLimits).toHaveBeenCalledWith(false)
    expect(readCursorAuthSession).not.toHaveBeenCalled()
    expect(fetchCursorRateLimits).not.toHaveBeenCalled()
    expect(service.getState().gemini).toBeNull()
    expect(service.getState().cursor).toBeNull()
    // Why: an enabled provider in the same cycle still fetches normally.
    expect(fetchOpenCodeGoUsage).toHaveBeenCalledTimes(1)
  })

  it('never reads the Grok CLI auth file when Grok is switched off', () => {
    new RateLimitService({ isUsageProviderDisabled: (providerId) => providerId === 'grok' })

    expect(readGrokAuthSession).not.toHaveBeenCalled()
  })

  it('never reaches OpenCode\u2019s own credential store when OpenCode Go is switched off', async () => {
    // Why this case exists: an empty settings key makes this fetcher resolve OpenCode's environment and
    // credential database itself, so a resolver-only gate still read a credential and could send a
    // request. The result being nulled afterwards was too late.
    const service = new RateLimitService({
      isUsageProviderDisabled: (providerId) => providerId === 'opencode-go'
    })

    await service.refresh()

    expect(fetchOpenCodeGoUsage).not.toHaveBeenCalled()
    expect(service.getState().opencodeGo).toBeNull()
  })

  it('never resolves a Kimi home or reads its credentials when Kimi is switched off', async () => {
    // fork-comment-ok: resolving the home probes wsl.exe and the home holds the sign-in, so the gate must land before the resolver.
    const kimiHomeResolver = vi.fn(async () => ({
      runtime: 'wsl' as const,
      wslDistro: 'Ubuntu',
      path: '\\\\wsl.localhost\\Ubuntu\\home\\neil\\.kimi-code'
    }))
    const service = new RateLimitService({
      isUsageProviderDisabled: (providerId) => providerId === 'kimi'
    })
    service.setKimiHomeResolver(kimiHomeResolver)

    await service.refresh()

    expect(kimiHomeResolver).not.toHaveBeenCalled()
    expect(fetchKimiRateLimits).not.toHaveBeenCalled()
    expect(service.getState().kimi).toBeNull()
  })

  it('never reads the GLM plan key or polls it when GLM Coding Plan is switched off', async () => {
    // fork-comment-ok: the plan key lives in the encrypted store, so a disabled GLM must return from its config resolver.
    const zcodePlanConfigResolver = vi.fn(() => ({ apiKey: 'plan-key', site: 'zai' as const }))
    const service = new RateLimitService({
      isUsageProviderDisabled: (providerId) => providerId === 'zcode'
    })
    service.setZcodePlanConfigResolver(zcodePlanConfigResolver)

    await service.refresh()

    expect(zcodePlanConfigResolver).not.toHaveBeenCalled()
    expect(fetchZcodeRateLimits).not.toHaveBeenCalled()
    expect(service.getState().zcodePlanApiKeyConfigured).toBe(false)
  })

  it('never spawns the agy usage probe when Antigravity is switched off', async () => {
    const service = new RateLimitService({
      isUsageProviderDisabled: (providerId) => providerId === 'antigravity'
    })

    await service.refresh()

    expect(fetchAntigravityRateLimits).not.toHaveBeenCalled()
    expect(service.getState().antigravity).toBeNull()
  })

  it('never spawns the Muse CLI when Muse is switched off, even with its meter showing', async () => {
    // Why the visible meter: the switch used to gate only the meter, so the CLI ran anyway.
    const service = new RateLimitService({
      isUsageProviderDisabled: (providerId) => providerId === 'muse'
    })
    service.setMuseUsageEnabledResolver(() => true)

    await service.refresh()

    expect(fetchMuseRateLimits).not.toHaveBeenCalled()
    expect(service.getState().muse).toBeNull()
  })
})
