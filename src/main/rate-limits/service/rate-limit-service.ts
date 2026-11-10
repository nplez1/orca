import {
  localAccountRuntimeTargetKey,
  type LocalAccountRuntimeTarget
} from '../../../shared/local-account-runtime'
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
import { RateLimitServiceAccountRefresh } from './service-account-refresh'
import type { AntigravityAccountUsageRecorder } from '../providers/antigravity/antigravity-account-usage'
import {
  type CodexAccountSelectionTarget,
  normalizeCodexAccountSelectionTarget
} from '../../../shared/codex-selection-lane'
import type {
  CodexHomePathResolver,
  KimiHomeResolver,
  ClaudeAuthPreparationResolver,
  OpenCodeGoRateLimitConfig,
  MiniMaxRateLimitConfig,
  AntigravityUsageEnabledResolver,
  MuseUsageEnabledResolver,
  ZcodePlanRateLimitConfig,
  DeepSeekRateLimitConfig,
  DeepInfraRateLimitConfig,
  FireworksRateLimitConfig,
  CopilotRateLimitConfig,
  GeminiCliOAuthEnabledResolver,
  InactiveCodexAccountInfo
} from './service-types'
import {
  type ClaudeAccountSelectionTarget,
  normalizeClaudeAccountSelectionTarget
} from '../../claude-accounts/runtime-selection'
import type { InactiveClaudeAccount } from '../providers/claude/claude-managed-account-usage'
import type { RateLimitState } from '../../../shared/rate-limit-types'
import type { NetworkProxySettings } from '../../../shared/network-proxy'

export class RateLimitService extends RateLimitServiceAccountRefresh {
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
    apiKeyResolver?: () => string | null
  ): void {
    this.openCodeGoConfigResolver = resolver
    this.openCodeGoApiKeyResolver = apiKeyResolver ?? null
  }

  setMiniMaxConfigResolver(resolver: () => MiniMaxRateLimitConfig): void {
    this.miniMaxConfigResolver = resolver
  }

  setZcodePlanConfigResolver(resolver: () => ZcodePlanRateLimitConfig): void {
    this.zcodePlanConfigResolver = resolver
  }

  setDeepSeekConfigResolver(resolver: () => DeepSeekRateLimitConfig): void {
    this.deepSeekConfigResolver = resolver
  }

  setFireworksConfigResolver(resolver: () => FireworksRateLimitConfig): void {
    this.fireworksConfigResolver = resolver
  }

  setDeepInfraConfigResolver(resolver: () => DeepInfraRateLimitConfig): void {
    this.deepInfraConfigResolver = resolver
  }

  setCopilotConfigResolver(resolver: () => CopilotRateLimitConfig): void {
    this.copilotConfigResolver = resolver
  }

  setGeminiCliOAuthEnabledResolver(resolver: GeminiCliOAuthEnabledResolver): void {
    this.geminiCliOAuthEnabledResolver = resolver
  }

  setAntigravityUsageEnabledResolver(resolver: AntigravityUsageEnabledResolver): void {
    this.antigravityUsageEnabledResolver = resolver
  }

  setAntigravityFetchTarget(target: LocalAccountRuntimeTarget): void {
    if (
      localAccountRuntimeTargetKey(target) ===
      localAccountRuntimeTargetKey(this.antigravityFetchTarget)
    ) {
      return
    }
    this.antigravityFetchTarget = { ...target }
    this.antigravityFetchGeneration += 1
    this.antigravityAccounts = []
    this.activeFailureStreakByProvider.antigravity = 0
    this.updateState({ ...this.state, antigravity: null })
  }

  setAntigravityAccountUsageRecorder(recorder: AntigravityAccountUsageRecorder): void {
    this.antigravityAccountUsageRecorder = recorder
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
    if (options.fetchImmediately !== false) {
      this.clearDeferredStartupRefresh()
      void this.fetchAll()
    } else {
      this.scheduleDeferredStartupRefresh()
    }
    this.startTimer()
  }

  stop(): void {
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

  getState(): RateLimitState {
    this.pruneInactiveClaudeState()
    this.pruneInactiveCodexState()
    // Why: these presence flags come from credential files on disk, so a switched-off
    // provider must report false without its store being touched.
    const disabled = this.disabledUsageProviderIds()
    return {
      ...this.state,
      // Why: the cookie lives on the filesystem, not GlobalSettings; surface its presence so the renderer keeps the MiniMax bar across reloads.
      minimaxCookieConfigured: disabled.has('minimax') ? false : hasMiniMaxSessionCookie(),
      minimaxApiKeyConfigured: disabled.has('minimax') ? false : hasMiniMaxApiKey(),
      zcodePlanApiKeyConfigured: disabled.has('zcode') ? false : hasZcodePlanApiKey(),
      opencodeGoApiKeyConfigured: disabled.has('opencode-go')
        ? false
        : this.openCodeGoApiKeyConfigured,
      // Why: these credentials live on disk, so main is the only place that can tell the renderer a provider is set up before its first fetch lands.
      deepseekApiKeyConfigured: disabled.has('deepseek') ? false : hasDeepSeekApiKey(),
      fireworksApiKeyConfigured: disabled.has('fireworks') ? false : hasFireworksCredentials(),
      deepinfraApiKeyConfigured: disabled.has('deepinfra') ? false : hasDeepInfraApiKey(),
      copilotTokenConfigured: disabled.has('copilot')
        ? false
        : hasCopilotCredentials() || getCachedCopilotGhCredentials()?.status === 'ok',
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
      antigravityAccounts: this.antigravityAccounts
    }
  }
}
