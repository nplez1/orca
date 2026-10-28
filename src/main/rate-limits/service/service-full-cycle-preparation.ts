import { fetchClaudeRateLimits } from '../claude-fetcher'
import { fetchCodexRateLimits } from '../codex-fetcher'
import { fetchGeminiRateLimits } from '../gemini-usage-fetcher'
import { fetchGrokRateLimits } from '../grok-fetcher'
import { readGrokAuthSession } from '../grok-auth'
import { fetchCursorRateLimits } from '../cursor-fetcher'
import { readCursorAuthSession } from '../cursor-auth'
import { fetchZcodeRateLimits } from '../zcode-usage-fetcher'
import { fetchAntigravityRateLimits } from '../antigravity-usage-fetcher'
import { antigravityUsageDisabledSnapshot } from '../antigravity-usage-snapshot'
import { ZCODE_PLAN_SITE_BASE_URLS } from '../../../shared/zcode-plan-sites'
import { fetchMiniMaxRateLimits } from '../minimax/minimax-fetcher'
import { createHash } from 'node:crypto'
import { fetchOpenCodeGoUsage } from '../opencode-go-usage-source-selection'
import { prepareForkProviderCycle } from '../fork/fork-provider-cycle'
import { RateLimitServiceCycleFetchState } from './service-cycle-fetch-state'
import { trackSettledProviderResult } from './service-sibling-provider-result'
import type { FetchAllCyclePrepared, ProviderRateLimits } from './service-types'

export abstract class RateLimitServiceFullCyclePreparation extends RateLimitServiceCycleFetchState {
  protected async prepareFetchAllCycle(
    signal: AbortSignal,
    options?: { force?: boolean }
  ): Promise<FetchAllCyclePrepared | null> {
    if (signal.aborted) {
      return null
    }
    // Why: a disabled provider is neither polled nor read from local tooling; each
    // gate below skips a credential read or substitutes a hidden snapshot.
    const disabled = this.disabledUsageProviderIds()
    this.resetDisabledProviderCredentialFlags(disabled)
    const claudeTarget = this.claudeFetchTarget
    // Capture before await so a switch invalidates both attribution and result application.
    const claudeGeneration = this.claudeFetchGeneration
    const claudeAuthPreparation = disabled.has('claude')
      ? undefined
      : await this.claudeAuthPreparationResolver?.(claudeTarget)
    if (signal.aborted) {
      return null
    }
    this.rememberClaudeAuthSnapshot(claudeAuthPreparation, claudeGeneration, claudeTarget)
    const claudeProvenance = claudeAuthPreparation?.provenance ?? 'system'
    const codexTarget = this.codexFetchTarget
    // Capture before await so a reset invalidates this cycle.
    const codexGeneration = this.codexFetchGeneration
    // Gate only Codex, never siblings, when its runtime is skipped (#STA-4422).
    // Why: resolveCodexHome probes credential homes, so a disabled Codex skips it entirely.
    const codexHome = disabled.has('codex') ? null : await this.resolveCodexHome(codexTarget)
    const previousState = this.state
    const antigravityGeneration = this.antigravityFetchGeneration
    const codexFetchGated = disabled.has('codex') || codexHome?.skip === true
    const codexHomePath = codexHome?.homePath ?? null
    const codexStateBeforeFetch =
      previousState.codex?.status === 'fetching' ? null : previousState.codex
    const codexProvenance = codexFetchGated
      ? null
      : this.getCodexProvenance(codexTarget, codexHomePath)
    const openCodeGoConfig = this.resolveOpenCodeGoConfig()
    // Why a call-site gate for this one provider: the other disabled providers are gated inside their
    // resolvers, but this fetcher treats an empty settings key as "look elsewhere" and resolves OpenCode's
    // own credential store and environment, then can make the request. UpdateState nulling the result
    // afterwards is too late — the read already happened.
    const openCodeGoDisabled = this.isUsageProviderDisabled('opencode-go')
    const cookie = openCodeGoConfig.sessionCookie
    const workspaceIdOverride = openCodeGoConfig.workspaceIdOverride
    const openCodeGoApiKey = openCodeGoConfig.apiKey
    const openCodeGoApiKeyError = openCodeGoConfig.apiKeyError
    const openCodeGoApiKeyReadSkipped = openCodeGoConfig.apiKeyReadSkipped
    const miniMaxConfigResult = this.resolveMiniMaxConfig()
    const miniMaxCookie = miniMaxConfigResult.config.sessionCookie
    const miniMaxGroupId = miniMaxConfigResult.config.groupId
    const miniMaxModels = miniMaxConfigResult.config.models
    const miniMaxEndpoint = miniMaxConfigResult.config.endpoint
    const miniMaxApiKey = miniMaxConfigResult.config.apiKey
    const forkProviderCycle = prepareForkProviderCycle({
      disabled,
      resolveConfigs: () => ({
        deepSeek: this.resolveDeepSeekConfig(),
        fireworks: this.resolveFireworksConfig(),
        copilot: this.resolveCopilotConfig()
      }),
      syncGenerations: (fingerprints) => ({
        deepSeek: this.syncDeepSeekFetchGeneration(fingerprints.deepSeek),
        fireworks: this.syncFireworksFetchGeneration(fingerprints.fireworks),
        copilot: this.syncCopilotFetchGeneration(fingerprints.copilot)
      }),
      apiKeyCredentialError: (provider, message) => this.getApiKeyCredentialError(provider, message)
    })
    const geminiCliOAuthEnabled = disabled.has('gemini')
      ? false
      : (this.geminiCliOAuthEnabledResolver?.() ?? false)
    // Probe auth during fetch, not hot renderer/mobile getState calls.
    const grokAuthReadResult = disabled.has('grok') ? null : readGrokAuthSession()
    this.grokAuthConfigured = disabled.has('grok') ? false : grokAuthReadResult?.status === 'ok'

    // Config changes discard old-account usage; hash credentials because only identity changes matter.
    const apiKeyFingerprint = openCodeGoApiKey
      ? createHash('sha256').update(openCodeGoApiKey).digest('hex')
      : ''
    const currentConfigHash = `${cookie}|${workspaceIdOverride}|${apiKeyFingerprint}|${openCodeGoApiKeyError ?? ''}`
    const opencodeConfigChanged = currentConfigHash !== this.lastOpencodeConfigHash
    const opencodeGeneration = this.syncOpencodeFetchGeneration(currentConfigHash)

    const currentMiniMaxConfigHash = `${miniMaxCookie}|${miniMaxGroupId}|${miniMaxModels}|${miniMaxEndpoint}|${miniMaxApiKey}|${miniMaxConfigResult.error ?? ''}`
    const miniMaxConfigChanged = currentMiniMaxConfigHash !== this.lastMiniMaxConfigHash
    const miniMaxGeneration = this.syncMiniMaxFetchGeneration(currentMiniMaxConfigHash)

    const antigravityFetchAllowed =
      (this.antigravityUsageEnabledResolver?.() ?? true) &&
      (options?.force || !this.shouldSkipAutomatedFetch('antigravity', previousState.antigravity))

    const zcodePlanConfigResult = this.resolveZcodePlanConfig()
    const zcodePlanApiKey = zcodePlanConfigResult.config.apiKey
    // Hash credentials because only changes matter, never retain the raw key here.
    const currentZcodeConfigHash = zcodePlanApiKey
      ? `${zcodePlanConfigResult.config.site}|${createHash('sha256').update(zcodePlanApiKey).digest('hex')}`
      : (zcodePlanConfigResult.error ?? '')
    const zcodeConfigChanged = currentZcodeConfigHash !== this.lastZcodeConfigHash
    const zcodeGeneration = this.syncZcodeFetchGeneration(currentZcodeConfigHash)
    const zcodePlanCredential = zcodePlanApiKey
      ? {
          apiKey: zcodePlanApiKey,
          baseUrl: ZCODE_PLAN_SITE_BASE_URLS[zcodePlanConfigResult.config.site]
        }
      : null

    this.markProvidersFetching({
      previousState,
      codexFetchGated,
      codexStateBeforeFetch,
      antigravityUsageEnabled: antigravityFetchAllowed,
      changed: {
        opencodeGo: opencodeConfigChanged,
        minimax: miniMaxConfigChanged,
        deepseek: forkProviderCycle.deepSeek.configChanged,
        fireworks: forkProviderCycle.fireworks.configChanged,
        copilot: forkProviderCycle.copilot.configChanged,
        zcode: zcodeConfigChanged
      }
    })

    // Async Keychain/worker DB reads must not delay other providers.
    const cursorResultPromise = disabled.has('cursor')
      ? trackSettledProviderResult(Promise.resolve(this.disabledUsageProviderSnapshot('cursor')))
      : trackSettledProviderResult(
          readCursorAuthSession().then((authReadResult) => {
            this.cursorAuthConfigured = authReadResult.status === 'ok'
            return fetchCursorRateLimits({ signal, authReadResult })
          })
        )

    const zcodeResultPromise = trackSettledProviderResult(
      zcodePlanConfigResult.error
        ? Promise.resolve(this.getZcodePlanCredentialError(zcodePlanConfigResult.error))
        : fetchZcodeRateLimits({ signal, planCredential: zcodePlanCredential })
    )

    // Hidden meters avoid the CLI spawn; the separate promise keeps other providers responsive.
    const antigravityResultPromise = trackSettledProviderResult(
      antigravityFetchAllowed
        ? fetchAntigravityRateLimits({ signal })
        : Promise.resolve(previousState.antigravity ?? antigravityUsageDisabledSnapshot())
    )

    const missingWslCodexHome =
      codexFetchGated || codexHomePath ? null : this.getMissingWslCodexHomeResult(codexTarget)
    // Why: reading Grok's auth file is the credential import, so a disabled Grok never reaches it.
    const grokResultPromise = grokAuthReadResult
      ? trackSettledProviderResult(
          fetchGrokRateLimits({ signal, authReadResult: grokAuthReadResult })
        )
      : trackSettledProviderResult(Promise.resolve(this.disabledUsageProviderSnapshot('grok')))

    // Live display does not waive automated Retry-After gates.
    const claudeFetchGated =
      disabled.has('claude') ||
      (!options?.force && this.shouldSkipAutomatedFetch('claude', previousState.claude))

    const [claudeResult, codexResult, geminiResult, opencodeGoResult, kimiResult, miniMaxResult] =
      await Promise.allSettled([
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
              networkProxySettings: this.networkProxySettingsResolver?.(),
              signal
            })),
        fetchGeminiRateLimits(geminiCliOAuthEnabled),
        openCodeGoDisabled
          ? Promise.resolve(this.disabledUsageProviderSnapshot('opencode-go'))
          : fetchOpenCodeGoUsage({
              settingsApiKey: openCodeGoApiKey,
              // Store/env keys become known only when the fetch resolves them.
              onApiKeyResolved: (resolution) => {
                // A credential change invalidates stale in-flight presence results.
                if (opencodeGeneration !== this.opencodeFetchGeneration) {
                  return
                }
                // An undecryptable or briefly unreadable saved key still counts, so the bar stays up.
                this.openCodeGoApiKeyConfigured =
                  resolution.status === 'found' ||
                  openCodeGoApiKeyError !== null ||
                  openCodeGoApiKeyReadSkipped
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
            })
      ])

    if (signal.aborted) {
      return null
    }
    // Decryption diagnosis fills only an otherwise undiagnosed empty result; preserve actual cookie failures.
    if (
      openCodeGoApiKeyError &&
      opencodeGoResult.status === 'fulfilled' &&
      opencodeGoResult.value.status === 'unavailable'
    ) {
      opencodeGoResult.value = {
        ...opencodeGoResult.value,
        error: openCodeGoApiKeyError,
        status: 'error'
      }
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
      zcodeConfigChanged,
      zcodeGeneration,
      forkProviderCycle,
      antigravityGeneration,
      claudeFetchGated,
      results: [
        claudeResult,
        codexResult,
        geminiResult,
        opencodeGoResult,
        kimiResult,
        miniMaxResult
      ],
      grokResultPromise,
      cursorResultPromise,
      zcodeResultPromise,
      antigravityResultPromise
    }
  }
}
