// Keep Electron imports out: both desktop and orcad bundle these account services.
import { getClaudeAgentViewService } from './claude/agent-view-service'
import type { Store } from './persistence'
import { RateLimitService } from './rate-limits/service'
import { CodexRuntimeHomeService } from './codex-accounts/runtime-home-service'
import { CodexAccountService } from './codex-accounts/service'
import { ClaudeRuntimeAuthService } from './claude-accounts/runtime-auth-service'
import { ClaudeAccountService } from './claude-accounts/service'
import { getInitialCodexRateLimitTarget } from './rate-limits/codex-rate-limit-target'
import { getInitialClaudeRateLimitTarget } from './rate-limits/claude-rate-limit-target'
import { getKimiRuntimeTarget, resolveKimiHome } from './kimi/kimi-runtime-home'
import { isWslDistroRunningForBackgroundWork } from './wsl-background-distro-gate'
import { inactiveCodexHomeUnlessStopped } from './rate-limits/inactive-codex-home'
import { readMiniMaxSessionCookie } from './minimax/minimax-cookie-store'
import { readMiniMaxApiKey } from './minimax/minimax-api-key-store'
import { readZcodePlanApiKey } from './zcode/zcode-plan-api-key-store'
import { readOpenCodeGoApiKey } from './opencode/opencode-go-api-key-store'
import { setAntigravityNativeCredentialChangeListener } from './antigravity/native-account-host'
import { createAccountRuntimeTargetSettingsSync } from './rate-limits/account-runtime-target-sync'
import { normalizeCodexRuntimeSelection } from './codex-accounts/runtime-selection'
import { normalizeClaudeRuntimeSelection } from './claude-accounts/runtime-selection'
import { readDeepSeekApiKey } from './deepseek/deepseek-api-key-store'
import { readFireworksCredentials } from './fireworks/fireworks-credentials-store'
import { readCopilotCredentials } from './copilot-credentials/copilot-credentials-store'
import { refreshCopilotGhCredentials } from './rate-limits/copilot/copilot-gh-credentials'
import { isUsageProviderDisabled } from '../shared/usage-provider-enablement'
import type { ClaudeStatusLineRateLimits } from '../shared/claude-statusline-rate-limits'

export type ProviderAccountServices = {
  rateLimits: RateLimitService
  codexRuntimeHome: CodexRuntimeHomeService
  codexAccounts: CodexAccountService
  claudeRuntimeAuth: ClaudeRuntimeAuthService
  claudeAccounts: ClaudeAccountService
}

export function createProviderAccountServices(
  store: Store,
  options: {
    codexAccountLifecycle?: ConstructorParameters<typeof CodexAccountService>[3]
    setClaudeStatusLineListener: (listener: (event: ClaudeStatusLineRateLimits) => void) => void
  }
): ProviderAccountServices {
  const agentView = getClaudeAgentViewService()
  void agentView.reconcile(store.getSettings())
  // Why the probe at construction: the service reads Grok's CLI auth file once
  // while constructing, and a provider the user switched off must be skipped then.
  const rateLimits = new RateLimitService({
    isUsageProviderDisabled: (providerId) =>
      isUsageProviderDisabled(store.getSettings().disabledUsageProviders, providerId)
  })
  const codexRuntimeHome = new CodexRuntimeHomeService(store)
  const codexAccounts = new CodexAccountService(
    store,
    rateLimits,
    codexRuntimeHome,
    options.codexAccountLifecycle
  )
  const claudeRuntimeAuth = new ClaudeRuntimeAuthService(store)
  const claudeAccounts = new ClaudeAccountService(store, rateLimits, claudeRuntimeAuth)
  // Background quota polls must not boot stopped distros; user-driven resets may prepare them.
  rateLimits.setCodexHomePathResolver(async (target) =>
    target?.runtime === 'wsl' && !(await isWslDistroRunningForBackgroundWork(target.wslDistro))
      ? { kind: 'skip' }
      : codexRuntimeHome.prepareForRateLimitFetch(target)
  )
  rateLimits.setCodexFetchTarget(getInitialCodexRateLimitTarget(store.getSettings()))
  // Read credentials where Kimi’s CLI refreshes its token, including WSL (#12370).
  rateLimits.setKimiHomeResolver(() => resolveKimiHome(getKimiRuntimeTarget(store.getSettings())))
  rateLimits.setClaudeFetchTarget(getInitialClaudeRateLimitTarget(store.getSettings()))
  const syncAccountRuntimeTargets = createAccountRuntimeTargetSettingsSync(
    rateLimits,
    store.getSettings()
  )
  store.onSettingsChanged((updates, settings) => {
    void agentView.reconcile(settings)
    // Auto runtime selection remains live as provider settings change.
    void syncAccountRuntimeTargets(updates, settings).catch((error) =>
      console.warn('[rate-limits] Failed to apply account runtime target:', error)
    )
    if ('opencodeSessionCookie' in updates || 'opencodeWorkspaceId' in updates) {
      rateLimits.invalidateOpenCodeGoCredentialState()
      void rateLimits.refresh().catch((error: unknown) => {
        console.warn(
          '[rate-limits] Failed to refresh OpenCode Go usage after a settings change:',
          error
        )
      })
    }
    // Why: enabling or disabling a provider must take effect without waiting for the
    // next poll window, and a re-enabled Grok needs its CLI auth re-read.
    if ('disabledUsageProviders' in updates) {
      rateLimits.initializeUsageProviderReads()
      // Why: the gh probe result is cached, so a re-enabled Copilot must not wait
      // for a restart before its next cycle sees the sign-in again.
      if (!isUsageProviderDisabled(settings.disabledUsageProviders, 'copilot')) {
        void refreshCopilotGhCredentials()
      }
      void rateLimits.refresh().catch((error: unknown) => {
        console.warn(
          '[rate-limits] Failed to refresh after a provider enable/disable change:',
          error
        )
      })
    }
    // Why: these three pick the MiniMax host and quota bucket, so a stale snapshot from the
    // previous endpoint would otherwise sit in the status bar until the next poll.
    if (
      'minimaxEndpoint' in updates ||
      'minimaxGroupId' in updates ||
      'minimaxUsageModels' in updates
    ) {
      rateLimits.invalidateMiniMaxCredentialState()
      void rateLimits.refresh().catch((error: unknown) => {
        console.warn(
          '[rate-limits] Failed to refresh MiniMax usage after a settings change:',
          error
        )
      })
    }
    // Clear quota data from the old GLM Coding Plan site before the next poll.
    if ('zcodePlanSite' in updates) {
      rateLimits.invalidateZcodeCredentialState()
      void rateLimits.refresh().catch((error: unknown) => {
        console.warn(
          '[rate-limits] Failed to refresh GLM Coding Plan usage after a settings change:',
          error
        )
      })
    }
  })
  rateLimits.setClaudeAuthPreparationResolver((target) =>
    claudeRuntimeAuth.prepareForRateLimitFetch(target)
  )
  // Live statusLine usage avoids OAuth endpoint polling and its 429s.
  options.setClaudeStatusLineListener((event) => {
    rateLimits.ingestLiveClaudeRateLimits(event)
  })
  rateLimits.setOpenCodeGoConfigResolver(() => {
    const settings = store.getSettings()
    return {
      sessionCookie: settings.opencodeSessionCookie,
      workspaceIdOverride: settings.opencodeWorkspaceId
    }
  }, readOpenCodeGoApiKey)
  rateLimits.setMiniMaxConfigResolver(() => {
    const settings = store.getSettings()
    const apiKey = readMiniMaxApiKey() ?? ''
    return {
      sessionCookie: apiKey ? '' : (readMiniMaxSessionCookie() ?? ''),
      groupId: settings.minimaxGroupId,
      models: settings.minimaxUsageModels,
      endpoint: settings.minimaxEndpoint,
      apiKey
    }
  })
  rateLimits.setZcodePlanConfigResolver(() => ({
    site: store.getSettings().zcodePlanSite ?? 'zai',
    apiKey: readZcodePlanApiKey() ?? ''
  }))
  rateLimits.setDeepSeekConfigResolver(() => ({ apiKey: readDeepSeekApiKey() ?? '' }))
  // Why: readFireworksCredentials throws on an undecryptable file, and letting it
  // throw records a Fireworks-only credential error instead of a silent keyless poll.
  rateLimits.setFireworksConfigResolver(() => {
    const credentials = readFireworksCredentials()
    return {
      apiKey: credentials?.apiKey ?? '',
      accountIdOverride: credentials?.accountIdOverride ?? null
    }
  })
  // Why: readCopilotCredentials throws on an undecryptable payload, and letting it
  // throw records a Copilot-only credential error instead of a silent keyless poll.
  rateLimits.setCopilotConfigResolver(() => {
    const credentials = readCopilotCredentials()
    return {
      token: credentials?.token ?? '',
      enterpriseSlug: credentials?.enterpriseSlug ?? ''
    }
  })
  // Why warmed at startup: the fetch cycle reads the probe synchronously, so kicking it
  // off here means the first cycle already knows about a usable GitHub CLI sign-in.
  // Why gated: a disabled Copilot must not spawn the `gh auth status` probe at all.
  if (!isUsageProviderDisabled(store.getSettings().disabledUsageProviders, 'copilot')) {
    void refreshCopilotGhCredentials()
  }
  rateLimits.setGeminiCliOAuthEnabledResolver(() => store.getSettings().geminiCliOAuthEnabled)
  // Reuse the meter switch so hidden Antigravity usage does not spawn agy.
  rateLimits.setAntigravityUsageEnabledResolver(() =>
    store.getUI().statusBarItems.includes('antigravity')
  )
  setAntigravityNativeCredentialChangeListener(() =>
    rateLimits.invalidateAntigravityCredentialState()
  )
  rateLimits.setNetworkProxySettingsResolver(() => store.getSettings())
  rateLimits.setInactiveClaudeAccountsResolver(() => {
    const settings = store.getSettings()
    const activeIds = new Set(
      [
        normalizeClaudeRuntimeSelection(settings).host,
        ...Object.values(normalizeClaudeRuntimeSelection(settings).wsl)
      ].filter(Boolean)
    )
    return settings.claudeManagedAccounts
      .filter((account) => !activeIds.has(account.id))
      .map((account) => ({
        id: account.id,
        managedAuthRuntime: account.managedAuthRuntime,
        wslDistro: account.wslDistro,
        wslLinuxAuthPath: account.wslLinuxAuthPath
      }))
  })
  rateLimits.setInactiveCodexAccountsResolver(() => {
    const settings = store.getSettings()
    const activeIds = new Set(
      [
        normalizeCodexRuntimeSelection(settings).host,
        ...Object.values(normalizeCodexRuntimeSelection(settings).wsl)
      ].filter(Boolean)
    )
    return settings.codexManagedAccounts
      .filter((account) => !activeIds.has(account.id))
      .map((account) => ({
        id: account.id,
        resolveHome: () =>
          inactiveCodexHomeUnlessStopped(
            codexRuntimeHome.resolveCodexManagedAccountHomeForInactiveFetch(account)
          )
      }))
  })
  return { rateLimits, codexRuntimeHome, codexAccounts, claudeRuntimeAuth, claudeAccounts }
}
