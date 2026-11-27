import type { BrowserWindow } from 'electron'
import { hasMiniMaxSessionCookie } from '../../minimax/minimax-cookie-store'
import { hasMiniMaxApiKey } from '../../minimax/minimax-api-key-store'
import { hasZcodePlanApiKey } from '../../zcode/zcode-plan-api-key-store'
import { hasDeepSeekApiKey } from '../../deepseek/deepseek-api-key-store'
import { hasDeepInfraApiKey } from '../../deepinfra/deepinfra-api-key-store'
import { hasFireworksCredentials } from '../../fireworks/fireworks-credentials-store'
import { hasCopilotCredentials } from '../../copilot-credentials/copilot-credentials-store'
import { getCachedCopilotGhCredentials } from '../copilot/copilot-gh-credentials'
import { disabledUsageProviderFlagOverrides } from '../../../shared/usage-providers/usage-provider-readouts'
import { RateLimitServiceTargetUsageRead } from './service-target-usage-read'
import {
  type CodexAccountSelectionTarget,
  normalizeCodexAccountSelectionTarget
} from '../../../shared/agent-accounts/codex/codex-selection-lane'
import {
  MIN_REFETCH_MS,
  type CodexHomePathResolver,
  type KimiHomeResolver,
  type ClaudeAuthPreparationResolver,
  type OpenCodeGoRateLimitConfig,
  type MiniMaxRateLimitConfig,
  type ClaudeOAuthUsageEnabledResolver,
  type MuseUsageEnabledResolver,
  type ZcodePlanRateLimitConfig,
  type DeepSeekRateLimitConfig,
  type DeepInfraRateLimitConfig,
  type FireworksRateLimitConfig,
  type CopilotRateLimitConfig,
  type InactiveCodexAccountInfo
} from './service-types'
import {
  type ClaudeAccountSelectionTarget,
  normalizeClaudeAccountSelectionTarget
} from '../../claude-accounts/selection/runtime-selection'
import type { InactiveClaudeAccount } from '../providers/claude/claude-managed-account-usage'
import type { RateLimitState } from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { NetworkProxySettings } from '../../../shared/network/network-proxy'

export class RateLimitService extends RateLimitServiceTargetUsageRead {
  private lastOwnerReturnAt = Number.NEGATIVE_INFINITY

  refreshOnOwnerReturn(): Promise<void> {
    const now = Date.now()
    const elapsed = now - this.lastOwnerReturnAt
    // Admit and restamp after a backward clock change.
    if (elapsed >= 0 && elapsed < MIN_REFETCH_MS) {
      return Promise.resolve()
    }
    this.lastOwnerReturnAt = now
    // An unwatched return stamps the interval but leaves the stale reading to the next watched one.
    return this.isUsageWatched() ? this.refreshIfWatched() : Promise.resolve()
  }

  setCodexHomePathResolver(resolver: CodexHomePathResolver): void {
    this.codexHomePathResolver = resolver
  }

  setCodexFetchTarget(target?: CodexAccountSelectionTarget): void {
    this.codexFetchTarget = normalizeCodexAccountSelectionTarget(target)
  }

  setKimiHomeResolver(resolver: KimiHomeResolver): void {
    this.kimiHomeResolver = resolver
  }

  setClaudeAuthPreparationResolver(resolver: ClaudeAuthPreparationResolver): void {
    this.claudeAuthPreparationResolver = resolver
  }

  setClaudeFetchTarget(target?: ClaudeAccountSelectionTarget): void {
    this.claudeFetchTarget = normalizeClaudeAccountSelectionTarget(target)
  }

  setOpenCodeGoConfigResolver(
    resolver: () => OpenCodeGoRateLimitConfig,
    apiKeyResolver?: () => string | null | Promise<string | null>
  ): void {
    this.openCodeGoConfigResolver = resolver
    this.openCodeGoApiKeyResolver = apiKeyResolver ?? null
  }

  setMiniMaxConfigResolver(
    resolver: () => MiniMaxRateLimitConfig | Promise<MiniMaxRateLimitConfig>
  ): void {
    this.miniMaxConfigResolver = resolver
  }

  setZcodePlanConfigResolver(
    resolver: () => ZcodePlanRateLimitConfig | Promise<ZcodePlanRateLimitConfig>
  ): void {
    this.zcodePlanConfigResolver = resolver
  }

  setDeepSeekConfigResolver(
    resolver: () => DeepSeekRateLimitConfig | Promise<DeepSeekRateLimitConfig>
  ): void {
    this.deepSeekConfigResolver = resolver
  }

  setFireworksConfigResolver(
    resolver: () => FireworksRateLimitConfig | Promise<FireworksRateLimitConfig>
  ): void {
    this.fireworksConfigResolver = resolver
  }

  setDeepInfraConfigResolver(
    resolver: () => DeepInfraRateLimitConfig | Promise<DeepInfraRateLimitConfig>
  ): void {
    this.deepInfraConfigResolver = resolver
  }

  setCopilotConfigResolver(
    resolver: () => CopilotRateLimitConfig | Promise<CopilotRateLimitConfig>
  ): void {
    this.copilotConfigResolver = resolver
  }

  setClaudeOAuthUsageEnabledResolver(resolver: ClaudeOAuthUsageEnabledResolver): void {
    this.claudeOAuthUsageEnabledResolver = resolver
  }

  // Retain only readings actually received from the terminal feed.
  discardClaudeOAuthUsage(): void {
    this.claudeUsageAbortController.abort()
    this.claudeUsageAbortController = new AbortController()
    this.claudeFetchGeneration += 1
    this.inactiveClaudeAccountsGeneration += 1
    this.inactiveClaudeCache.clear()
    this.inactiveClaudeFetching.clear()
    this.lastInactiveClaudeFetchAt = 0
    this.lastClaudeCheckCompletedAt = null
    this.activeFailureStreakByProvider.claude = 0
    this.updateState({ ...this.state, claude: this.claudeUsageWithoutOAuth() })
    if (!this.lastClaudeAuthSnapshot) {
      void this.fetchClaudeOnly({ force: true })
    }
  }

  setMuseUsageEnabledResolver(resolver: MuseUsageEnabledResolver): void {
    this.museUsageEnabledResolver = resolver
  }

  setNetworkProxySettingsResolver(resolver: () => NetworkProxySettings): void {
    this.networkProxySettingsResolver = resolver
  }

  setInactiveClaudeAccountsResolver(resolver: () => InactiveClaudeAccount[]): void {
    this.inactiveClaudeAccountsResolver = resolver
    this.inactiveClaudeAccountsGeneration += 1
  }

  setInactiveCodexAccountsResolver(resolver: () => InactiveCodexAccountInfo[]): void {
    this.inactiveCodexAccountsResolver = resolver
    this.inactiveCodexAccountsGeneration += 1
    this.pruneInactiveCodexState()
  }
  attach(mainWindow: BrowserWindow): void {
    this.detachWindowListeners?.()
    this.mainWindow = mainWindow
    const refreshOnResume = (): void => {
      void this.refreshIfWatched()
    }
    // Replacing windows must also detach the old closed listener.
    const detachWindowListeners = (): void => {
      mainWindow.removeListener('focus', refreshOnResume)
      mainWindow.removeListener('show', refreshOnResume)
      mainWindow.removeListener('restore', refreshOnResume)
      mainWindow.removeListener('closed', onClosed)
    }
    const onClosed = (): void => {
      detachWindowListeners()
      if (this.detachWindowListeners === detachWindowListeners) {
        this.detachWindowListeners = null
      }
      if (this.mainWindow === mainWindow) {
        this.mainWindow = null
      }
    }
    mainWindow.on('focus', refreshOnResume)
    mainWindow.on('show', refreshOnResume)
    mainWindow.on('restore', refreshOnResume)
    mainWindow.on('closed', onClosed)
    this.detachWindowListeners = detachWindowListeners
    // Quota probes spawn CLIs/use network; defer past first paint, then show/focus refresh.
    this.scheduleDeferredStartupRefresh()
  }

  /** Counts a paired client's usage stream so polls run without a focused window; returns its release. */
  addUsageViewer(): () => void {
    this.usageViewers += 1
    let released = false
    return () => {
      if (!released) {
        released = true
        this.usageViewers -= 1
      }
    }
  }

  start(options: { fetchImmediately?: boolean } = {}): void {
    this.publicationStopped = false
    if (options.fetchImmediately !== false) {
      this.clearDeferredStartupRefresh()
      void this.fetchAll()
    } else {
      this.scheduleDeferredStartupRefresh()
      // Passive terminal usage needs account attribution even without a usage viewer.
      if (!this.isClaudeOAuthUsageEnabled()) {
        void this.fetchClaudeOnly({ force: true })
      }
    }
    this.startTimer()
  }

  stop(): void {
    this.publicationStopped = true
    this.abortActiveFetchCycle()
    this.clearQueuedFetches()
    this.inactiveClaudeFetching.clear()
    this.inactiveCodexFetching.clear()
    this.resolveAndClearFetchIdleWaiters()
    this.stopTimer()
    this.clearDeferredStartupRefresh()
    this.detachWindowListeners?.()
    this.detachWindowListeners = null
    this.mainWindow = null
  }

  async getState(): Promise<RateLimitState> {
    this.pruneInactiveClaudeState()
    this.pruneInactiveCodexState()
    // Why: these presence flags come from credential files on disk, so a switched-off
    // provider must report false without its store being touched.
    const disabled = this.disabledUsageProviderIds()
    const [
      minimaxCookieConfigured,
      minimaxApiKeyConfigured,
      zcodePlanApiKeyConfigured,
      deepseekApiKeyConfigured,
      fireworksApiKeyConfigured,
      deepInfraApiKeyConfigured,
      copilotCredentialsConfigured
    ] = await Promise.all([
      disabled.has('minimax') ? false : hasMiniMaxSessionCookie(),
      disabled.has('minimax') ? false : hasMiniMaxApiKey(),
      disabled.has('zcode') ? false : hasZcodePlanApiKey(),
      disabled.has('deepseek') ? false : hasDeepSeekApiKey(),
      disabled.has('fireworks') ? false : hasFireworksCredentials(),
      disabled.has('deepinfra') ? false : hasDeepInfraApiKey(),
      disabled.has('copilot') ? false : hasCopilotCredentials()
    ])
    return {
      ...this.state,
      // Why: the cookie lives on the filesystem, not GlobalSettings; surface its presence so the renderer keeps the MiniMax bar across reloads.
      minimaxCookieConfigured,
      minimaxApiKeyConfigured,
      zcodePlanApiKeyConfigured,
      opencodeGoApiKeyConfigured: disabled.has('opencode-go')
        ? false
        : this.openCodeGoApiKeyConfigured,
      // Why: these credentials live on disk, so main is the only place that can tell the renderer a provider is set up before its first fetch lands.
      deepseekApiKeyConfigured,
      fireworksApiKeyConfigured,
      deepinfraApiKeyConfigured: deepInfraApiKeyConfigured,
      copilotTokenConfigured: disabled.has('copilot')
        ? false
        : copilotCredentialsConfigured || getCachedCopilotGhCredentials()?.status === 'ok',
      grokAuthConfigured: this.grokAuthConfigured,
      cursorAuthConfigured: this.cursorAuthConfigured,
      ...disabledUsageProviderFlagOverrides(disabled),
      claudeTarget: this.claudeFetchTarget,
      codexTarget: this.codexFetchTarget,
      inactiveClaudeAccounts: this.buildInactiveArray(
        this.inactiveClaudeCache,
        this.inactiveClaudeFetching
      ),
      inactiveCodexAccounts: this.buildInactiveArray(
        this.inactiveCodexCache,
        this.inactiveCodexFetching
      ),
      antigravityAccounts: []
    }
  }
}
