import type { BrowserWindow } from 'electron'
import type {
  InactiveAccountUsage,
  ProviderRateLimits,
  RateLimitState
} from '../../../shared/rate-limit-types'
import type { DisableableUsageProviderId } from '../../../shared/usage-provider-enablement'
import { USAGE_PROVIDER_IDS } from '../../../shared/usage-provider-enablement'
import {
  type ActiveRateLimitProvider,
  type InactiveCodexAccountInfo,
  type InternalRateLimitState,
  type CodexHomePathResolver,
  type KimiHomeResolver,
  type ClaudeAuthPreparationResolver,
  type OpenCodeGoRateLimitConfig,
  type MiniMaxRateLimitConfig,
  type DeepSeekRateLimitConfig,
  type FireworksRateLimitConfig,
  type CopilotRateLimitConfig,
  type GeminiCliOAuthEnabledResolver,
  USAGE_PROVIDER_STATE_KEYS,
  type NormalizedCodexAccountSelectionTarget,
  type NormalizedClaudeAccountSelectionTarget,
  type InactiveClaudeAccountInfo,
  type NetworkProxySettings,
  DEFAULT_POLL_MS
} from './service-types'
import { readGrokAuthSession } from '../grok-auth'

export abstract class RateLimitServiceState {
  protected state: InternalRateLimitState = {
    claude: null,
    codex: null,
    gemini: null,
    opencodeGo: null,
    kimi: null,
    antigravity: null,
    minimax: null,
    grok: null,
    cursor: null,
    zcode: null,
    deepseek: null,
    fireworks: null,
    copilot: null
  }
  protected grokAuthConfigured = false
  // Why: the Cursor probe reads the macOS Keychain, so it cannot run synchronously
  // at construction the way Grok's auth-file probe does; each fetch cycle sets it.
  protected cursorAuthConfigured = false
  protected openCodeGoApiKeyConfigured = false
  protected pollInterval: number = DEFAULT_POLL_MS
  protected timer: ReturnType<typeof setInterval> | null = null
  protected deferredStartupRefreshTimer: ReturnType<typeof setTimeout> | null = null
  // Why: throttle repeated focus/show/restore events so one outage doesn't create a tight provider retry loop.
  protected lastActiveFailureRetryAtByProvider: Record<ActiveRateLimitProvider, number> = {
    claude: 0,
    codex: 0,
    gemini: 0,
    'opencode-go': 0,
    kimi: 0,
    minimax: 0,
    grok: 0,
    antigravity: 0,
    cursor: 0,
    zcode: 0,
    deepseek: 0,
    fireworks: 0,
    copilot: 0
  }
  // Why: consecutive failures drive exponential backoff of the fast activation-retry lane; reset on any success/unavailable result.
  protected activeFailureStreakByProvider: Record<ActiveRateLimitProvider, number> = {
    claude: 0,
    codex: 0,
    gemini: 0,
    'opencode-go': 0,
    kimi: 0,
    minimax: 0,
    grok: 0,
    antigravity: 0,
    cursor: 0,
    zcode: 0,
    deepseek: 0,
    fireworks: 0,
    copilot: 0
  }
  protected mainWindow: BrowserWindow | null = null
  protected detachWindowListeners: (() => void) | null = null
  protected isFetching = false
  protected fullFetchQueued = false
  protected codexOnlyFetchQueued = false
  protected claudeOnlyFetchQueued = false
  protected grokOnlyFetchQueued = false
  protected activeFetchAbortControllers = new Set<AbortController>()
  protected fetchIdleResolvers: (() => void)[] = []
  protected codexFetchGeneration = 0
  protected claudeFetchGeneration = 0
  // Why: statusline ingest must attribute live windows to the selected account without re-running the side-effectful auth sync per post.
  protected lastClaudeAuthSnapshot: { configDir: string | null; provenance: string } | null = null
  protected opencodeFetchGeneration = 0
  protected minimaxFetchGeneration = 0
  protected deepseekFetchGeneration = 0
  protected fireworksFetchGeneration = 0
  protected copilotFetchGeneration = 0
  protected lastOpencodeConfigHash = ''
  protected lastMiniMaxConfigHash = ''
  // Why: API keys live on disk, not in settings, so a paste is only observable as a config-hash change between cycles.
  protected lastDeepSeekConfigHash = ''
  protected lastFireworksConfigHash = ''
  protected lastCopilotConfigHash = ''
  protected codexHomePathResolver: CodexHomePathResolver | null = null
  protected codexFetchTarget: NormalizedCodexAccountSelectionTarget = {
    runtime: 'host',
    wslDistro: null
  }
  // Why: resolved per cycle — the local-account runtime policy can flip between fetches.
  protected kimiHomeResolver: KimiHomeResolver | null = null
  protected claudeAuthPreparationResolver: ClaudeAuthPreparationResolver | null = null
  protected claudeFetchTarget: NormalizedClaudeAccountSelectionTarget = {
    runtime: 'host',
    wslDistro: null
  }
  protected openCodeGoConfigResolver: (() => OpenCodeGoRateLimitConfig) | null = null
  protected miniMaxConfigResolver: (() => MiniMaxRateLimitConfig) | null = null
  protected deepSeekConfigResolver: (() => DeepSeekRateLimitConfig) | null = null
  protected fireworksConfigResolver: (() => FireworksRateLimitConfig) | null = null
  protected copilotConfigResolver: (() => CopilotRateLimitConfig) | null = null
  protected geminiCliOAuthEnabledResolver: GeminiCliOAuthEnabledResolver | null = null
  protected inactiveClaudeAccountsResolver: (() => InactiveClaudeAccountInfo[]) | null = null
  protected inactiveCodexAccountsResolver: (() => InactiveCodexAccountInfo[]) | null = null
  protected networkProxySettingsResolver: (() => NetworkProxySettings) | null = null
  protected inactiveClaudeCache = new Map<string, ProviderRateLimits>()
  protected inactiveCodexCache = new Map<string, ProviderRateLimits>()
  protected inactiveClaudeFetching = new Set<string>()
  protected inactiveCodexFetching = new Set<string>()
  protected inactiveCodexFetchInFlight = false
  protected lastInactiveClaudeFetchAt = 0
  protected inactiveClaudeAccountsGeneration = 0
  protected lastInactiveCodexFetchAt = 0
  protected inactiveCodexAccountsGeneration = 0
  protected stateListeners = new Set<(state: RateLimitState) => void>()

  private readonly usageProviderDisabledProbe:
    | ((providerId: DisableableUsageProviderId) => boolean)
    | null = null

  constructor(options?: {
    isUsageProviderDisabled?: (providerId: DisableableUsageProviderId) => boolean
  }) {
    this.usageProviderDisabledProbe = options?.isUsageProviderDisabled ?? null
    // Why read here, not in a field initializer: the probe must exist first, so a
    // provider the user already switched off never has its CLI auth file read.
    this.grokAuthConfigured = this.readGrokAuthConfiguredIfEnabled()
  }

  /** Re-evaluates the provider reads that depend on settings the constructor cannot see. */
  initializeUsageProviderReads(): void {
    this.grokAuthConfigured = this.readGrokAuthConfiguredIfEnabled()
  }

  protected isUsageProviderDisabled(providerId: DisableableUsageProviderId): boolean {
    return this.usageProviderDisabledProbe?.(providerId) ?? false
  }

  protected disabledUsageProviderIds(): ReadonlySet<DisableableUsageProviderId> {
    const disabled = new Set<DisableableUsageProviderId>()
    for (const providerId of USAGE_PROVIDER_IDS) {
      if (this.isUsageProviderDisabled(providerId)) {
        disabled.add(providerId)
      }
    }
    return disabled
  }

  /** A disabled provider must stop reporting a live credential presence. */
  protected resetDisabledProviderCredentialFlags(
    disabled: ReadonlySet<DisableableUsageProviderId>
  ): void {
    if (disabled.has('cursor')) {
      this.cursorAuthConfigured = false
    }
    if (disabled.has('opencode-go')) {
      this.openCodeGoApiKeyConfigured = false
    }
  }

  /** Reads the Grok CLI auth file only while Grok is enabled, so a disabled provider has no local credential import. */
  protected readGrokAuthConfiguredIfEnabled(): boolean {
    if (this.isUsageProviderDisabled('grok')) {
      return false
    }
    return readGrokAuthSession().status === 'ok'
  }

  /**
   * State slots for switched-off providers. Spread last so it wins over the
   * per-provider values a cycle computed, and so a prior reading cannot linger.
   */
  protected disabledUsageProviderStateOverrides(): Partial<InternalRateLimitState> {
    const overrides: Partial<InternalRateLimitState> = {}
    for (const providerId of this.disabledUsageProviderIds()) {
      overrides[USAGE_PROVIDER_STATE_KEYS[providerId]] = null
    }
    return overrides
  }

  /** Hidden placeholder a disabled provider resolves to, so the cycle's result tuple stays typed without a network call. */
  protected disabledUsageProviderSnapshot(provider: ActiveRateLimitProvider): ProviderRateLimits {
    return {
      provider,
      session: null,
      weekly: null,
      ...(provider === 'opencode-go' ? { monthly: null } : {}),
      ...(provider === 'gemini' || provider === 'cursor' ? { buckets: [] } : {}),
      ...(provider === 'deepseek' || provider === 'fireworks' ? { credits: null } : {}),
      ...(provider === 'copilot' ? { monthly: null, allowance: null } : {}),
      updatedAt: Date.now(),
      error: null,
      status: 'unavailable'
    }
  }

  /** Runs the real fetch, or resolves a hidden snapshot when the user switched the provider off. */
  protected fetchUnlessDisabled(
    providerId: DisableableUsageProviderId,
    load: () => Promise<ProviderRateLimits>
  ): Promise<ProviderRateLimits> {
    return this.isUsageProviderDisabled(providerId)
      ? Promise.resolve(this.disabledUsageProviderSnapshot(providerId))
      : load()
  }

  onStateChange(listener: (state: RateLimitState) => void): () => void {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  protected abstract getState(): RateLimitState

  protected buildInactiveArray(
    cache: Map<string, ProviderRateLimits>,
    fetching: Set<string>
  ): InactiveAccountUsage[] {
    const result: InactiveAccountUsage[] = []
    for (const [accountId, limits] of cache) {
      result.push({
        accountId,
        rateLimits: limits,
        updatedAt: limits.updatedAt,
        isFetching: fetching.has(accountId)
      })
    }
    // Why: include fetching-but-uncached accounts so the renderer shows a loading indicator for newly added accounts.
    for (const accountId of fetching) {
      if (!cache.has(accountId)) {
        result.push({
          accountId,
          rateLimits: null,
          updatedAt: 0,
          isFetching: true
        })
      }
    }
    return result
  }

  protected updateState(next: InternalRateLimitState): void {
    this.state = next
    this.pushToRenderer()
  }

  protected pushToRenderer(): void {
    const state = this.getState()
    for (const listener of this.stateListeners) {
      try {
        listener(state)
      } catch {
        // ignore — one bad listener must not break the others
      }
    }
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return
    }
    this.mainWindow.webContents.send('rateLimits:update', state)
  }
}
