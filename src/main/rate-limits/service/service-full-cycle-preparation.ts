import { fetchClaudeRateLimits } from '../claude-fetcher'
import { fetchCodexRateLimits } from '../codex-fetcher'
import { fetchDeepSeekRateLimits } from '../deepseek/deepseek-fetcher'
import { fetchFireworksRateLimits } from '../fireworks/fireworks-fetcher'
import { fetchCopilotRateLimits } from '../copilot/copilot-fetcher'
import { fetchGeminiRateLimits } from '../gemini-usage-fetcher'
import { fetchGrokRateLimits } from '../grok-fetcher'
import { readGrokAuthSession } from '../grok-auth'
import { fetchMiniMaxRateLimits } from '../minimax/minimax-fetcher'
import { createHash } from 'node:crypto'
import { fetchOpenCodeGoUsage } from '../opencode-go-usage-source-selection'
import { RateLimitServiceFetchPolicy } from './service-fetch-policy'
import type {
  ClaudeRuntimeAuthPreparation,
  InternalRateLimitState,
  NormalizedClaudeAccountSelectionTarget,
  NormalizedCodexAccountSelectionTarget,
  ProviderRateLimits
} from './service-types'

export type FetchAllCyclePrepared = {
  claudeTarget: NormalizedClaudeAccountSelectionTarget
  claudeGeneration: number
  claudeAuthPreparation: ClaudeRuntimeAuthPreparation | undefined
  claudeProvenance: string
  codexTarget: NormalizedCodexAccountSelectionTarget
  previousState: InternalRateLimitState
  codexFetchGated: boolean
  codexStateBeforeFetch: ProviderRateLimits | null
  codexProvenance: string | null
  codexGeneration: number
  opencodeConfigChanged: boolean
  opencodeGeneration: number
  miniMaxConfigChanged: boolean
  miniMaxGeneration: number
  deepSeekConfigChanged: boolean
  deepSeekGeneration: number
  fireworksConfigChanged: boolean
  fireworksGeneration: number
  copilotConfigChanged: boolean
  copilotGeneration: number
  claudeFetchGated: boolean
  results: [
    PromiseSettledResult<ProviderRateLimits>,
    PromiseSettledResult<ProviderRateLimits>,
    PromiseSettledResult<ProviderRateLimits>,
    PromiseSettledResult<ProviderRateLimits>,
    PromiseSettledResult<ProviderRateLimits>,
    PromiseSettledResult<ProviderRateLimits>,
    PromiseSettledResult<ProviderRateLimits>,
    PromiseSettledResult<ProviderRateLimits>,
    PromiseSettledResult<ProviderRateLimits>
  ]
  grokResultPromise: Promise<
    { status: 'fulfilled'; value: ProviderRateLimits } | { status: 'rejected'; reason: unknown }
  >
}

export abstract class RateLimitServiceFullCyclePreparation extends RateLimitServiceFetchPolicy {
  protected async prepareFetchAllCycle(
    signal: AbortSignal,
    options?: { force?: boolean }
  ): Promise<FetchAllCyclePrepared | null> {
    if (signal.aborted) {
      return null
    }
    const claudeTarget = this.claudeFetchTarget
    // Why: capture before the resolver await so an account switch during it invalidates both the snapshot and the state apply.
    const claudeGeneration = this.claudeFetchGeneration
    const claudeAuthPreparation = await this.claudeAuthPreparationResolver?.(claudeTarget)
    if (signal.aborted) {
      return null
    }
    this.rememberClaudeAuthSnapshot(claudeAuthPreparation, claudeGeneration, claudeTarget)
    const claudeProvenance = claudeAuthPreparation?.provenance ?? 'system'
    const codexTarget = this.codexFetchTarget
    const previousState = this.state
    // Why: a skipped Codex poll must not stop the other providers' cycle, so gate
    // only the Codex slot instead of returning early (#STA-4422).
    const codexHome = this.resolveCodexHome(codexTarget)
    const codexFetchGated = codexHome.skip
    const codexHomePath = codexHome.homePath
    const codexStateBeforeFetch =
      previousState.codex?.status === 'fetching' ? null : previousState.codex
    const codexProvenance = codexFetchGated
      ? null
      : this.getCodexProvenance(codexTarget, codexHomePath)
    const codexGeneration = this.codexFetchGeneration
    const openCodeGoConfig = this.openCodeGoConfigResolver?.()
    const cookie = openCodeGoConfig?.sessionCookie ?? ''
    const workspaceIdOverride = openCodeGoConfig?.workspaceIdOverride ?? ''
    const openCodeGoApiKey = openCodeGoConfig?.apiKey ?? ''
    const miniMaxConfigResult = this.resolveMiniMaxConfig()
    const miniMaxCookie = miniMaxConfigResult.config.sessionCookie
    const miniMaxGroupId = miniMaxConfigResult.config.groupId
    const miniMaxModels = miniMaxConfigResult.config.models
    const miniMaxEndpoint = miniMaxConfigResult.config.endpoint
    const miniMaxApiKey = miniMaxConfigResult.config.apiKey
    const deepSeekConfigResult = this.resolveDeepSeekConfig()
    const deepSeekApiKey = deepSeekConfigResult.config.apiKey
    const fireworksConfigResult = this.resolveFireworksConfig()
    const fireworksApiKey = fireworksConfigResult.config.apiKey
    const fireworksAccountIdOverride = fireworksConfigResult.config.accountIdOverride
    const copilotConfigResult = this.resolveCopilotConfig()
    const copilotToken = copilotConfigResult.config.token
    const copilotEnterpriseSlug = copilotConfigResult.config.enterpriseSlug
    const geminiCliOAuthEnabled = this.geminiCliOAuthEnabledResolver?.() ?? false
    // Why: getState() is hot (renderer pushes + mobile snapshots); keep Grok's sync auth-file probe on fetch cycles instead.
    const grokAuthReadResult = readGrokAuthSession()
    this.grokAuthConfigured = grokAuthReadResult.status === 'ok'

    // Discard stale data on config change — it belongs to a different session/workspace.
    // Digest, not the key: this string only has to change when the account does.
    const apiKeyFingerprint = openCodeGoApiKey
      ? createHash('sha256').update(openCodeGoApiKey).digest('hex')
      : ''
    const currentConfigHash = `${cookie}|${workspaceIdOverride}|${apiKeyFingerprint}`
    const opencodeConfigChanged = currentConfigHash !== this.lastOpencodeConfigHash
    if (opencodeConfigChanged) {
      this.lastOpencodeConfigHash = currentConfigHash
      this.opencodeFetchGeneration += 1
    }
    const opencodeGeneration = this.opencodeFetchGeneration

    const currentMiniMaxConfigHash = `${miniMaxCookie}|${miniMaxGroupId}|${miniMaxModels}|${miniMaxEndpoint}|${miniMaxApiKey}|${miniMaxConfigResult.error ?? ''}`
    const miniMaxConfigChanged = currentMiniMaxConfigHash !== this.lastMiniMaxConfigHash
    if (miniMaxConfigChanged) {
      this.lastMiniMaxConfigHash = currentMiniMaxConfigHash
      this.minimaxFetchGeneration += 1
    }
    const miniMaxGeneration = this.minimaxFetchGeneration

    const currentDeepSeekConfigHash = `${deepSeekApiKey}|${deepSeekConfigResult.error ?? ''}`
    const deepSeekConfigChanged = currentDeepSeekConfigHash !== this.lastDeepSeekConfigHash
    if (deepSeekConfigChanged) {
      this.lastDeepSeekConfigHash = currentDeepSeekConfigHash
      this.deepseekFetchGeneration += 1
    }
    const deepSeekGeneration = this.deepseekFetchGeneration

    const currentFireworksConfigHash = `${fireworksApiKey}|${fireworksAccountIdOverride ?? ''}|${fireworksConfigResult.error ?? ''}`
    const fireworksConfigChanged = currentFireworksConfigHash !== this.lastFireworksConfigHash
    if (fireworksConfigChanged) {
      this.lastFireworksConfigHash = currentFireworksConfigHash
      this.fireworksFetchGeneration += 1
    }
    const fireworksGeneration = this.fireworksFetchGeneration

    const currentCopilotConfigHash = `${copilotToken}|${copilotEnterpriseSlug}|${copilotConfigResult.error ?? ''}`
    const copilotConfigChanged = currentCopilotConfigHash !== this.lastCopilotConfigHash
    if (copilotConfigChanged) {
      this.lastCopilotConfigHash = currentCopilotConfigHash
      this.copilotFetchGeneration += 1
    }
    const copilotGeneration = this.copilotFetchGeneration

    // Mark all providers fetching while keeping previous data visible (Codex is cleared separately on account change).
    this.updateState({
      ...previousState,
      claude: this.withFetchingStatus(previousState.claude, 'claude'),
      // Why: a gated Codex cycle makes no attempt; a "fetching" chip would never settle.
      codex: codexFetchGated
        ? codexStateBeforeFetch
        : this.withFetchingStatus(previousState.codex, 'codex'),
      gemini: this.withFetchingStatus(previousState.gemini, 'gemini'),
      opencodeGo: opencodeConfigChanged
        ? this.withFetchingStatus(null, 'opencode-go')
        : this.withFetchingStatus(previousState.opencodeGo, 'opencode-go'),
      kimi: this.withFetchingStatus(previousState.kimi, 'kimi'),
      antigravity: this.withFetchingStatus(previousState.antigravity, 'antigravity'),
      minimax: miniMaxConfigChanged
        ? this.withFetchingStatus(null, 'minimax')
        : this.withFetchingStatus(previousState.minimax, 'minimax'),
      deepseek: deepSeekConfigChanged
        ? this.withFetchingStatus(null, 'deepseek')
        : this.withFetchingStatus(previousState.deepseek, 'deepseek'),
      fireworks: fireworksConfigChanged
        ? this.withFetchingStatus(null, 'fireworks')
        : this.withFetchingStatus(previousState.fireworks, 'fireworks'),
      copilot: copilotConfigChanged
        ? this.withFetchingStatus(null, 'copilot')
        : this.withFetchingStatus(previousState.copilot, 'copilot'),
      grok: this.withFetchingStatus(previousState.grok, 'grok')
    })

    const missingWslCodexHome =
      codexFetchGated || codexHomePath ? null : this.getMissingWslCodexHomeResult(codexTarget)
    const grokResultPromise = fetchGrokRateLimits({
      signal,
      authReadResult: grokAuthReadResult
    }).then(
      (value) => ({ status: 'fulfilled', value }) as const,
      (reason) => ({ status: 'rejected', reason }) as const
    )

    // Why: skip automated Claude fetches while a Retry-After window is open or a live session feed is fresher than the OAuth poll would be.
    const claudeFetchGated =
      !options?.force && this.shouldSkipAutomatedClaudeFetch(previousState.claude)

    const [
      claudeResult,
      codexResult,
      geminiResult,
      opencodeGoResult,
      kimiResult,
      miniMaxResult,
      deepSeekResult,
      fireworksResult,
      copilotResult
    ] = await Promise.allSettled([
      claudeFetchGated
        ? Promise.resolve(previousState.claude as ProviderRateLimits)
        : fetchClaudeRateLimits({
            authPreparation: claudeAuthPreparation,
            allowPtyFallback: this.shouldAllowClaudePtyFallback(claudeAuthPreparation),
            allowUsagePanelSupplement: this.shouldAllowClaudeUsagePanelSupplement(),
            networkProxySettings: this.networkProxySettingsResolver?.(),
            signal
          }),
      codexFetchGated
        ? Promise.resolve(previousState.codex as ProviderRateLimits)
        : (missingWslCodexHome ??
          fetchCodexRateLimits({
            codexHomePath,
            allowPtyFallback: this.shouldAllowCodexPtyFallback(),
            signal
          })),
      fetchGeminiRateLimits(geminiCliOAuthEnabled),
      fetchOpenCodeGoUsage({
        settingsApiKey: openCodeGoApiKey,
        // Why here: the key can also come from the environment or OpenCode's
        // own store, so presence is only known once the fetch resolves it.
        onApiKeyResolved: (resolution) => {
          this.openCodeGoApiKeyConfigured = resolution.status === 'found'
        },
        cookie,
        workspaceIdOverride: workspaceIdOverride || undefined,
        networkProxySettings: this.networkProxySettingsResolver?.(),
        signal
      }),
      this.fetchKimiWithResolvedHome(),
      miniMaxConfigResult.error
        ? Promise.resolve(this.getMiniMaxCredentialError(miniMaxConfigResult.error))
        : fetchMiniMaxRateLimits({
            cookie: miniMaxCookie,
            groupId: miniMaxGroupId,
            models: miniMaxModels,
            endpointMode: miniMaxEndpoint,
            apiKey: miniMaxApiKey
          }),
      deepSeekConfigResult.error
        ? Promise.resolve(this.getApiKeyCredentialError('deepseek', deepSeekConfigResult.error))
        : fetchDeepSeekRateLimits({ apiKey: deepSeekApiKey }),
      fireworksConfigResult.error
        ? Promise.resolve(this.getApiKeyCredentialError('fireworks', fireworksConfigResult.error))
        : fetchFireworksRateLimits({
            apiKey: fireworksApiKey,
            accountIdOverride: fireworksAccountIdOverride
          }),
      copilotConfigResult.error
        ? Promise.resolve(this.getApiKeyCredentialError('copilot', copilotConfigResult.error))
        : fetchCopilotRateLimits({ token: copilotToken, enterpriseSlug: copilotEnterpriseSlug })
    ])

    if (signal.aborted) {
      return null
    }
    return {
      claudeTarget,
      claudeGeneration,
      claudeAuthPreparation,
      claudeProvenance,
      codexTarget,
      previousState,
      codexFetchGated,
      codexStateBeforeFetch,
      codexProvenance,
      codexGeneration,
      opencodeConfigChanged,
      opencodeGeneration,
      miniMaxConfigChanged,
      miniMaxGeneration,
      deepSeekConfigChanged,
      deepSeekGeneration,
      fireworksConfigChanged,
      fireworksGeneration,
      copilotConfigChanged,
      copilotGeneration,
      claudeFetchGated,
      results: [
        claudeResult,
        codexResult,
        geminiResult,
        opencodeGoResult,
        kimiResult,
        miniMaxResult,
        deepSeekResult,
        fireworksResult,
        copilotResult
      ],
      grokResultPromise
    }
  }
}
