import type { BrowserWindow } from 'electron'
import { hasMiniMaxSessionCookie } from '../../minimax/minimax-cookie-store'
import { hasMiniMaxApiKey } from '../../minimax/minimax-api-key-store'
import { hasDeepSeekApiKey } from '../../deepseek/deepseek-api-key-store'
import { hasFireworksCredentials } from '../../fireworks/fireworks-credentials-store'
import { hasCopilotCredentials } from '../../copilot-credentials/copilot-credentials-store'
import { getCachedCopilotGhCredentials } from '../copilot/copilot-gh-credentials'
import { RateLimitServiceAccountRefresh } from './service-account-refresh'
import {
  type CodexAccountSelectionTarget,
  type CodexHomePathResolver,
  type KimiHomeResolver,
  type ClaudeAccountSelectionTarget,
  type ClaudeAuthPreparationResolver,
  type OpenCodeGoRateLimitConfig,
  type MiniMaxRateLimitConfig,
  type DeepSeekRateLimitConfig,
  type FireworksRateLimitConfig,
  type CopilotRateLimitConfig,
  type GeminiCliOAuthEnabledResolver,
  type InactiveCodexAccountInfo,
  type InactiveClaudeAccountInfo,
  type RateLimitState,
  normalizeCodexAccountSelectionTarget,
  normalizeClaudeAccountSelectionTarget,
  type NetworkProxySettings
} from './service-types'

export abstract class RateLimitServiceConfiguration extends RateLimitServiceAccountRefresh {
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

  setOpenCodeGoConfigResolver(resolver: () => OpenCodeGoRateLimitConfig): void {
    this.openCodeGoConfigResolver = resolver
  }

  setMiniMaxConfigResolver(resolver: () => MiniMaxRateLimitConfig): void {
    this.miniMaxConfigResolver = resolver
  }

  setDeepSeekConfigResolver(resolver: () => DeepSeekRateLimitConfig): void {
    this.deepSeekConfigResolver = resolver
  }

  setFireworksConfigResolver(resolver: () => FireworksRateLimitConfig): void {
    this.fireworksConfigResolver = resolver
  }

  setCopilotConfigResolver(resolver: () => CopilotRateLimitConfig): void {
    this.copilotConfigResolver = resolver
  }

  setGeminiCliOAuthEnabledResolver(resolver: GeminiCliOAuthEnabledResolver): void {
    this.geminiCliOAuthEnabledResolver = resolver
  }

  setNetworkProxySettingsResolver(resolver: () => NetworkProxySettings): void {
    this.networkProxySettingsResolver = resolver
  }

  setInactiveClaudeAccountsResolver(resolver: () => InactiveClaudeAccountInfo[]): void {
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
      void this.refreshIfWindowActive()
    }
    // Why: attach() can replace windows; remove the previous closed listener too, not only the focus listeners.
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
  }

  start(options: { fetchImmediately?: boolean } = {}): void {
    if (options.fetchImmediately !== false) {
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
      // Why: a disabled provider's slot must read null on every push, not only the
      // cycle that first observed the toggle, so mobile and the renderer agree.
      ...this.disabledUsageProviderStateOverrides(),
      // Why: the cookie lives on the filesystem, not GlobalSettings; surface its presence so the renderer keeps the MiniMax bar across reloads.
      minimaxCookieConfigured: disabled.has('minimax') ? false : hasMiniMaxSessionCookie(),
      minimaxApiKeyConfigured: disabled.has('minimax') ? false : hasMiniMaxApiKey(),
      opencodeGoApiKeyConfigured: disabled.has('opencode-go')
        ? false
        : this.openCodeGoApiKeyConfigured,
      // Why: these credentials live on disk, so main is the only place that can tell the renderer a provider is set up before its first fetch lands.
      deepseekApiKeyConfigured: disabled.has('deepseek') ? false : hasDeepSeekApiKey(),
      fireworksApiKeyConfigured: disabled.has('fireworks') ? false : hasFireworksCredentials(),
      copilotTokenConfigured: disabled.has('copilot')
        ? false
        : hasCopilotCredentials() || getCachedCopilotGhCredentials()?.status === 'ok',
      grokAuthConfigured: this.grokAuthConfigured,
      cursorAuthConfigured: this.cursorAuthConfigured,
      claudeTarget: this.claudeFetchTarget,
      codexTarget: this.codexFetchTarget,
      inactiveClaudeAccounts: this.buildInactiveArray(
        this.inactiveClaudeCache,
        this.inactiveClaudeFetching
      ),
      inactiveCodexAccounts: this.buildInactiveArray(
        this.inactiveCodexCache,
        this.inactiveCodexFetching
      )
    }
  }
}
