import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  USAGE_PROVIDER_IDS,
  type DisableableUsageProviderId
} from '../../shared/usage-provider-enablement'
import { usageProviderConfiguredFlags } from '../../shared/usage-providers/usage-provider-readouts'
import { RateLimitService } from './service/rate-limit-service'
import {
  MIN_REFETCH_MS,
  USAGE_PROVIDER_STATE_KEYS,
  type RateLimitState
} from './service/service-types'
import {
  FakeRateLimitWindow,
  asRateLimitWindow,
  mockFreshBackgroundProviderFetches,
  okProvider,
  resetRateLimitProviderMocks
} from './service/rate-limit-service-test-harness'
import { fetchActiveClaudeRateLimits } from './providers/claude/claude-active-usage-fetch'
import { fetchCodexRateLimits } from './providers/codex/codex-fetcher'
import { fetchGeminiRateLimits } from './providers/gemini/gemini-usage-fetcher'
import { fetchKimiRateLimits } from './providers/kimi/kimi-fetcher'
import { fetchOpenCodeGoUsage } from './providers/opencode-go/opencode-go-usage-source-selection'
import { fetchZcodeRateLimits } from './providers/zcode/zcode-usage-fetcher'
import { fetchMuseRateLimits } from './providers/muse/muse-usage-fetcher'
import { fetchAntigravityRateLimits } from './providers/antigravity/antigravity-usage-fetcher'
import { fetchMiniMaxRateLimits } from './providers/minimax/minimax-fetcher'
import { fetchDeepSeekRateLimits } from './deepseek/deepseek-fetcher'
import { fetchFireworksRateLimits } from './fireworks/fireworks-fetcher'
import { fetchDeepInfraRateLimits } from './deepinfra/deepinfra-fetcher'
import { fetchCopilotRateLimits } from './copilot/copilot-fetcher'
import {
  getCachedCopilotGhCredentials,
  readCopilotGhCredentialsForCycle
} from './copilot/copilot-gh-credentials'
import { fetchGrokRateLimits } from './providers/grok/grok-fetcher'
import { readGrokAuthSession } from './providers/grok/grok-auth'
import { fetchCursorRateLimits } from './providers/cursor/cursor-fetcher'
import { readCursorAuthSession } from './providers/cursor/cursor-auth'
import { hasMiniMaxSessionCookie } from '../minimax/minimax-cookie-store'
import { hasMiniMaxApiKey } from '../minimax/minimax-api-key-store'
import { hasZcodePlanApiKey } from '../zcode/zcode-plan-api-key-store'
import { hasDeepSeekApiKey } from '../deepseek/deepseek-api-key-store'
import { hasFireworksCredentials } from '../fireworks/fireworks-credentials-store'
import { hasDeepInfraApiKey } from '../deepinfra/deepinfra-api-key-store'
import { hasCopilotCredentials } from '../copilot-credentials/copilot-credentials-store'

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

vi.mock('./providers/opencode-go/opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: vi.fn()
}))

vi.mock('./providers/zcode/zcode-usage-fetcher', () => ({
  fetchZcodeRateLimits: vi.fn()
}))

vi.mock('./providers/muse/muse-usage-fetcher', () => ({
  fetchMuseRateLimits: vi.fn()
}))

vi.mock('./providers/antigravity/antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
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

vi.mock('./providers/cursor/cursor-fetcher', () => ({
  fetchCursorRateLimits: vi.fn()
}))

vi.mock('./providers/cursor/cursor-auth', () => ({
  readCursorAuthSession: vi.fn()
}))

vi.mock('./providers/grok/grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))

vi.mock('../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

vi.mock('../minimax/minimax-api-key-store', () => ({
  hasMiniMaxApiKey: vi.fn(() => false)
}))

vi.mock('../zcode/zcode-plan-api-key-store', () => ({
  hasZcodePlanApiKey: vi.fn(() => false)
}))

vi.mock('../copilot-credentials/copilot-credentials-store', () => ({
  hasCopilotCredentials: vi.fn(() => false),
  readCopilotCredentials: vi.fn(() => null),
  saveCopilotCredentials: vi.fn(),
  clearCopilotCredentials: vi.fn()
}))

/** How "this provider was not queried" reads for one provider. */
type ProviderQuery =
  /** The fetcher is never invoked. */
  | { kind: 'skipped'; mock: () => Mock }
  /** The fetcher is always invoked carrying its own disabled flag, which must stay off. */
  | { kind: 'off-flag'; mock: () => Mock }

type ProviderEnablementWiring = {
  query: ProviderQuery
  /** Every local credential the fetch cycle or `getState()` would otherwise read. */
  credentialReads: (() => Mock)[]
}

/** The injected credential resolvers, one spy each, so a read is observable as a call. */
function createCredentialReadSpies() {
  return {
    claudeAuthPreparation: vi
      .fn(async () => ({
        configDir: '/claude',
        envPatch: {},
        provenance: 'system'
      }))
      .mockName('claudeAuthPreparation'),
    codexHomePath: vi
      .fn(async () => ({ kind: 'ready' as const, codexHomePath: '/codex' }))
      .mockName('codexHomePath'),
    kimiHome: vi
      .fn(async () => ({ runtime: 'host' as const, wslDistro: null, path: '/kimi-code' }))
      .mockName('kimiHome'),
    openCodeGoConfig: vi
      .fn(() => ({ sessionCookie: 'session=live', workspaceIdOverride: '' }))
      .mockName('openCodeGoConfig'),
    openCodeGoApiKey: vi.fn(() => 'sk-opencode').mockName('openCodeGoApiKey'),
    miniMaxConfig: vi
      .fn(() => ({
        sessionCookie: 'session=live',
        groupId: 'group',
        models: 'general',
        endpoint: 'overseas' as const,
        apiKey: 'sk-minimax'
      }))
      .mockName('miniMaxConfig'),
    zcodePlanConfig: vi
      .fn(() => ({ site: 'zai' as const, apiKey: 'plan-key' }))
      .mockName('zcodePlanConfig'),
    deepSeekConfig: vi.fn(() => ({ apiKey: 'sk-deepseek' })).mockName('deepSeekConfig'),
    fireworksConfig: vi
      .fn(() => ({ apiKey: 'fw-live', accountIdOverride: null }))
      .mockName('fireworksConfig'),
    deepInfraConfig: vi.fn(() => ({ apiKey: 'di-live' })).mockName('deepInfraConfig'),
    copilotConfig: vi
      .fn(() => ({ token: 'ghp_live', enterpriseSlug: '' }))
      .mockName('copilotConfig'),
    antigravityAccountUsage: {
      begin: vi.fn(async () => null).mockName('antigravityAccountUsage.begin'),
      finish: vi
        .fn(async () => ({ switched: true as const }))
        .mockName('antigravityAccountUsage.finish')
    }
  }
}

type CredentialReadSpies = ReturnType<typeof createCredentialReadSpies>

/** One entry per metered provider: `Record<ProviderRateLimits['provider'], …>` makes a new
 *  provider a compile error here, which is the whole point of the table. */
function providerWiring(
  spies: CredentialReadSpies
): Record<ProviderRateLimits['provider'], ProviderEnablementWiring> {
  const skipped = (mock: () => Mock): ProviderQuery => ({ kind: 'skipped', mock })
  return {
    claude: {
      query: skipped(() => vi.mocked(fetchActiveClaudeRateLimits)),
      credentialReads: [() => spies.claudeAuthPreparation]
    },
    codex: {
      query: skipped(() => vi.mocked(fetchCodexRateLimits)),
      credentialReads: [() => spies.codexHomePath]
    },
    // Why an off-flag rather than a skip: Gemini's fetcher takes the opt-in as its own gate,
    // so the call site always invokes it and passes the switch's state through.
    gemini: {
      query: { kind: 'off-flag', mock: () => vi.mocked(fetchGeminiRateLimits) },
      credentialReads: []
    },
    'opencode-go': {
      query: skipped(() => vi.mocked(fetchOpenCodeGoUsage)),
      credentialReads: [() => spies.openCodeGoConfig, () => spies.openCodeGoApiKey]
    },
    kimi: {
      query: skipped(() => vi.mocked(fetchKimiRateLimits)),
      credentialReads: [() => spies.kimiHome]
    },
    minimax: {
      query: skipped(() => vi.mocked(fetchMiniMaxRateLimits)),
      credentialReads: [
        () => spies.miniMaxConfig,
        () => vi.mocked(hasMiniMaxSessionCookie),
        () => vi.mocked(hasMiniMaxApiKey)
      ]
    },
    grok: {
      query: skipped(() => vi.mocked(fetchGrokRateLimits)),
      credentialReads: [() => vi.mocked(readGrokAuthSession)]
    },
    antigravity: {
      query: skipped(() => vi.mocked(fetchAntigravityRateLimits)),
      credentialReads: [() => spies.antigravityAccountUsage.begin]
    },
    cursor: {
      query: skipped(() => vi.mocked(fetchCursorRateLimits)),
      credentialReads: [() => vi.mocked(readCursorAuthSession)]
    },
    zcode: {
      query: skipped(() => vi.mocked(fetchZcodeRateLimits)),
      credentialReads: [() => spies.zcodePlanConfig, () => vi.mocked(hasZcodePlanApiKey)]
    },
    deepseek: {
      query: skipped(() => vi.mocked(fetchDeepSeekRateLimits)),
      credentialReads: [() => spies.deepSeekConfig, () => vi.mocked(hasDeepSeekApiKey)]
    },
    fireworks: {
      query: skipped(() => vi.mocked(fetchFireworksRateLimits)),
      credentialReads: [() => spies.fireworksConfig, () => vi.mocked(hasFireworksCredentials)]
    },
    deepinfra: {
      query: skipped(() => vi.mocked(fetchDeepInfraRateLimits)),
      credentialReads: [() => spies.deepInfraConfig, () => vi.mocked(hasDeepInfraApiKey)]
    },
    copilot: {
      query: skipped(() => vi.mocked(fetchCopilotRateLimits)),
      credentialReads: [
        () => spies.copilotConfig,
        () => vi.mocked(readCopilotGhCredentialsForCycle),
        () => vi.mocked(hasCopilotCredentials),
        () => vi.mocked(getCachedCopilotGhCredentials)
      ]
    },
    // Why only the fetch: the Muse CLI spawn is both the query and the credential read.
    muse: {
      query: skipped(() => vi.mocked(fetchMuseRateLimits)),
      credentialReads: []
    }
  }
}

/** Every credential these providers can read is present, and every status-bar item is on,
 *  so the provider switch is the only thing left that can stop a query. */
function configureLiveProviderAccess(service: RateLimitService, spies: CredentialReadSpies): void {
  service.setClaudeAuthPreparationResolver(spies.claudeAuthPreparation)
  service.setCodexHomePathResolver(spies.codexHomePath)
  service.setKimiHomeResolver(spies.kimiHome)
  service.setOpenCodeGoConfigResolver(spies.openCodeGoConfig, spies.openCodeGoApiKey)
  service.setMiniMaxConfigResolver(spies.miniMaxConfig)
  service.setZcodePlanConfigResolver(spies.zcodePlanConfig)
  service.setDeepSeekConfigResolver(spies.deepSeekConfig)
  service.setFireworksConfigResolver(spies.fireworksConfig)
  service.setDeepInfraConfigResolver(spies.deepInfraConfig)
  service.setCopilotConfigResolver(spies.copilotConfig)
  service.setAntigravityAccountUsageRecorder(spies.antigravityAccountUsage)
  service.setGeminiCliOAuthEnabledResolver(() => true)
  service.setAntigravityUsageEnabledResolver(() => true)
  service.setMuseUsageEnabledResolver(() => true)
}

function expectProviderNotQueried(
  wiring: ProviderEnablementWiring,
  provider: DisableableUsageProviderId,
  state: RateLimitState
): void {
  for (const read of wiring.credentialReads) {
    expect(read()).not.toHaveBeenCalled()
  }
  // Why from the manifest: the flags a provider owns are classified there, so this table
  // must not keep a second copy that a new provider could miss.
  for (const flag of usageProviderConfiguredFlags(provider)) {
    expect(state[flag]).toBe(false)
  }
  if (wiring.query.kind === 'skipped') {
    expect(wiring.query.mock()).not.toHaveBeenCalled()
    return
  }
  // Every cycle, not just the first: a later cycle that flipped the flag on would query.
  for (const call of wiring.query.mock().mock.calls) {
    expect(call[0]).toBe(false)
  }
}

function expectProviderQueried(wiring: ProviderEnablementWiring): void {
  // Why not `toHaveBeenCalled`: an off-flag fetcher is invoked either way, so only the flag
  // it carried distinguishes "queried" from "switched off".
  if (wiring.query.kind === 'skipped') {
    expect(wiring.query.mock()).toHaveBeenCalled()
    return
  }
  expect(wiring.query.mock().mock.calls.some((call) => call[0] === true)).toBe(true)
}

function stateSlot(
  state: RateLimitState,
  provider: DisableableUsageProviderId
): ProviderRateLimits | null {
  return state[USAGE_PROVIDER_STATE_KEYS[provider]]
}

/** Counts the cycles the focus path starts; `fetchAll` is called synchronously from the
 *  window listener, so a count taken right after `emit` is the real answer. */
class CountingFetchAllService extends RateLimitService {
  fetchAllCalls = 0
  inFlight: Promise<void> | null = null

  protected override async fetchAll(options?: { force?: boolean }): Promise<void> {
    this.fetchAllCalls += 1
    this.inFlight = super.fetchAll(options)
    await this.inFlight
  }
}

describe('usage provider enablement conformance', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetRateLimitProviderMocks()
    mockFreshBackgroundProviderFetches()
    vi.mocked(fetchActiveClaudeRateLimits).mockImplementation(async () => okProvider('claude', 12))
    vi.mocked(hasMiniMaxSessionCookie).mockReturnValue(true)
    vi.mocked(hasMiniMaxApiKey).mockReturnValue(true)
    vi.mocked(hasZcodePlanApiKey).mockReturnValue(true)
    vi.mocked(hasDeepSeekApiKey).mockReturnValue(true)
    vi.mocked(hasFireworksCredentials).mockReturnValue(true)
    vi.mocked(hasDeepInfraApiKey).mockReturnValue(true)
    vi.mocked(hasCopilotCredentials).mockReturnValue(true)
    // Why a live session each: a `missing` reader makes the grok/cursor presence flags read
    // false whether or not the switch gates them, so the flag assertions would be vacuous.
    vi.mocked(readGrokAuthSession).mockReturnValue({
      status: 'ok',
      session: {
        accessToken: 'grok-token',
        userId: null,
        email: null,
        teamId: null,
        expiresAtMs: null,
        oidcClientId: null
      }
    })
    vi.mocked(readCursorAuthSession).mockResolvedValue({
      status: 'ok',
      session: {
        email: null,
        displayName: null,
        membershipType: null,
        subscriptionStatus: null,
        token: { raw: 'cursor-token', subject: 'auth0|user_1', expiresAtMs: null },
        source: 'cli'
      }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // Why one parametrized case per provider: the hand-written tests that preceded this file
  // covered whichever provider the last bug happened to be about, so a provider whose wiring
  // drifted (Muse kept spawning its CLI with the switch off, #306) had no case to fail.
  it.each(USAGE_PROVIDER_IDS)(
    'never queries %s, reads its credentials, or refetches on focus when it is the only provider switched off',
    async (disabledProvider) => {
      await verifySwitchHonored([disabledProvider])
    }
  )

  // Why more than one: the deleted suite's only multi-provider case, and the disabled set is
  // walked in several places, so a set of one proves only the single-provider path.
  it('honours every switched-off provider at once', async () => {
    await verifySwitchHonored(['gemini', 'cursor'])
  })
})

async function verifySwitchHonored(
  disabledProviders: readonly DisableableUsageProviderId[]
): Promise<void> {
  const spies = createCredentialReadSpies()
  const wiring = providerWiring(spies)
  const service = new CountingFetchAllService({
    isUsageProviderDisabled: (providerId) => disabledProviders.includes(providerId)
  })
  configureLiveProviderAccess(service, spies)
  const window = new FakeRateLimitWindow()
  service.attach(asRateLimitWindow(window))

  try {
    await service.refresh()
    expect(service.fetchAllCalls).toBe(1)

    const state = service.getState()
    for (const provider of disabledProviders) {
      expectProviderNotQueried(wiring[provider], provider, state)
      expect(stateSlot(state, provider)).toBeNull()
    }
    // The switch turns off those providers, not the cycle: every sibling still queries.
    for (const provider of USAGE_PROVIDER_IDS) {
      if (!disabledProviders.includes(provider)) {
        expectProviderQueried(wiring[provider])
      }
    }

    // #300: a disabled slot is null on every push, so a plan that counted one saw a null
    // slot and refetched every provider on every focus.
    window.emit('focus')
    expect(service.fetchAllCalls).toBe(1)

    // Control: the same focus path does refetch once the throttle lapses, so the assertion
    // above is a gate and not a dead listener.
    await vi.advanceTimersByTimeAsync(MIN_REFETCH_MS + 1)
    window.emit('focus')
    expect(service.fetchAllCalls).toBe(2)
    await service.inFlight
    for (const provider of disabledProviders) {
      expectProviderNotQueried(wiring[provider], provider, service.getState())
      expect(stateSlot(service.getState(), provider)).toBeNull()
    }
  } finally {
    service.stop()
  }
}
