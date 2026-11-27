/* eslint-disable max-lines -- Why: upstream-owned and at its budget (286/300); the fork's +20-line delta rides inside it, and splitting costs a permanent sync hunk. */
import { fetchActiveClaudeRateLimits } from '../providers/claude/claude-active-usage-fetch'
import { fetchCodexRateLimits } from '../providers/codex/codex-fetcher'
import { fetchGrokRateLimits } from '../providers/grok/grok-fetcher'
import { readGrokAuthSession } from '../providers/grok/grok-auth'
import { fetchCursorRateLimits } from '../providers/cursor/cursor-fetcher'
import { readCursorAuthSession } from '../providers/cursor/cursor-auth'
import { fetchZcodeRateLimits } from '../providers/zcode/zcode-usage-fetcher'
import { ZCODE_PLAN_SITE_BASE_URLS } from '../../../shared/agent-accounts/usage-credentials/zcode-plan-sites'
import { fetchMiniMaxRateLimits } from '../providers/minimax/minimax-fetcher'
import { createHash } from 'node:crypto'
import { fetchOpenCodeGoUsage } from '../providers/opencode-go/opencode-go-usage-source-selection'
import { prepareForkProviderCycle } from '../fork/fork-provider-cycle'
import { RateLimitServiceCycleFetchState } from './service-cycle-fetch-state'
import { trackSettledProviderResult } from './service-sibling-provider-result'
import type { FetchAllCyclePrepared } from './full-cycle-prepared'
import type { ProviderRateLimits } from '../../../shared/agent-usage/rate-limits/rate-limit-types'

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
    const credentialGenerations = [
      this.opencodeFetchGeneration,
      this.minimaxFetchGeneration,
      this.zcodeFetchGeneration
    ]
    // Capture identities before awaits so a switch cannot reattribute the old credentials.
    const claudeTarget = this.claudeFetchTarget
    const claudeGeneration = this.claudeFetchGeneration
    // Why in one await with the Claude read: the fork resolvers read credential files, and a
    // separate round trip for them would add a microtask before this cycle's generation stamps.
    const [claudeAuthPreparation, [deepSeek, fireworks, deepInfra, copilot]] = await Promise.all([
      disabled.has('claude') ? undefined : this.claudeAuthPreparationResolver?.(claudeTarget),
      Promise.all([
        this.resolveDeepSeekConfig(),
        this.resolveFireworksConfig(),
        this.resolveDeepInfraConfig(),
        this.resolveCopilotConfig()
      ])
    ])
    if (signal.aborted) {
      return null
    }
    this.rememberClaudeAuthSnapshot(claudeAuthPreparation, claudeGeneration, claudeTarget)
    const claudeProvenance = claudeAuthPreparation?.provenance ?? 'system'
    const codexTarget = this.codexFetchTarget
    const codexGeneration = this.codexFetchGeneration
    // Gate only Codex, never siblings, when its runtime is skipped (#STA-4422).
    // Why: resolveCodexHome probes credential homes, so a disabled Codex skips it entirely.
    const codexHome = disabled.has('codex') ? null : await this.resolveCodexHome(codexTarget)
    const codexFetchGated = disabled.has('codex') || codexHome?.skip === true
    const codexHomePath = codexHome?.homePath ?? null
    const codexProvenance = codexFetchGated
      ? null
      : this.getCodexProvenance(codexTarget, codexHomePath)
    const openCodeGoConfig = await this.resolveOpenCodeGoConfig()
    // Why a call-site gate here: its config resolver cannot say "switched off", because this
    // fetcher treats an empty settings key as "look elsewhere" and resolves OpenCode's own
    // credential store and environment, then can make the request. UpdateState nulling the result
    // afterwards is too late — the read already happened.
    const openCodeGoDisabled = this.isUsageProviderDisabled('opencode-go')
    const cookie = openCodeGoConfig.sessionCookie
    const workspaceIdOverride = openCodeGoConfig.workspaceIdOverride
    const openCodeGoApiKey = openCodeGoConfig.apiKey
    const openCodeGoApiKeyError = openCodeGoConfig.apiKeyError
    const openCodeGoApiKeyReadSkipped = openCodeGoConfig.apiKeyReadSkipped
    const miniMaxConfigResult = await this.resolveMiniMaxConfig()
    const miniMaxCookie = miniMaxConfigResult.config.sessionCookie
    const miniMaxGroupId = miniMaxConfigResult.config.groupId
    const miniMaxModels = miniMaxConfigResult.config.models
    const miniMaxEndpoint = miniMaxConfigResult.config.endpoint
    const miniMaxApiKey = miniMaxConfigResult.config.apiKey
    const zcodePlanConfigResult = await this.resolveZcodePlanConfig()
    if (signal.aborted) {
      return null
    }
    if (
      claudeGeneration !== this.claudeFetchGeneration ||
      codexGeneration !== this.codexFetchGeneration ||
      credentialGenerations.some(
        (generation, index) =>
          generation !==
          [this.opencodeFetchGeneration, this.minimaxFetchGeneration, this.zcodeFetchGeneration][
            index
          ]
      )
    ) {
      // Retry through the existing queue with current account homes and credentials.
      this.fullFetchQueued ??= { force: options?.force ?? false }
      return null
    }
    // Preserve live usage received while credentials were loading.
    const previousState = this.state
    const codexStateBeforeFetch =
      previousState.codex?.status === 'fetching' ? null : previousState.codex
    const forkProviderCycle = prepareForkProviderCycle({
      disabled,
      signal,
      force: options?.force === true,
      previous: {
        deepseek: previousState.deepseek,
        fireworks: previousState.fireworks,
        deepinfra: previousState.deepinfra,
        copilot: previousState.copilot
      },
      isRetryAfterActive: (limits) => this.isRetryAfterActive(limits),
      configs: { deepSeek, fireworks, deepInfra, copilot },
      syncGenerations: (fingerprints) => ({
        deepSeek: this.syncDeepSeekFetchGeneration(fingerprints.deepSeek),
        fireworks: this.syncFireworksFetchGeneration(fingerprints.fireworks),
        deepInfra: this.syncDeepInfraFetchGeneration(fingerprints.deepInfra),
        copilot: this.syncCopilotFetchGeneration(fingerprints.copilot)
      }),
      apiKeyCredentialError: (provider, message) => this.getApiKeyCredentialError(provider, message)
    })
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
      changed: {
        opencodeGo: opencodeConfigChanged,
        minimax: miniMaxConfigChanged,
        deepseek: forkProviderCycle.deepSeek.configChanged,
        fireworks: forkProviderCycle.fireworks.configChanged,
        deepinfra: forkProviderCycle.deepInfra.configChanged,
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
      disabled.has('zcode')
        ? Promise.resolve(this.disabledUsageProviderSnapshot('zcode'))
        : zcodePlanConfigResult.error
          ? Promise.resolve(this.getZcodePlanCredentialError(zcodePlanConfigResult.error))
          : fetchZcodeRateLimits({ signal, planCredential: zcodePlanCredential })
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
      !this.isClaudeOAuthUsageEnabled() ||
      claudeGeneration !== this.claudeFetchGeneration ||
      (!options?.force && this.shouldSkipAutomatedFetch('claude', previousState.claude))
    const [claudeResult, codexResult, opencodeGoResult, kimiResult, miniMaxResult] =
      await Promise.allSettled([
        claudeFetchGated
          ? Promise.resolve(previousState.claude as ProviderRateLimits)
          : fetchActiveClaudeRateLimits({
              authPreparation: claudeAuthPreparation,
              allowPtyFallback: this.shouldAllowClaudePtyFallback(claudeAuthPreparation),
              allowUsagePanelSupplement: this.shouldAllowClaudeUsagePanelSupplement(),
              usageEndpointRetryAtMs: options?.force
                ? null
                : (previousState.claude?.usageMetadata?.retryAtMs ?? null),
              networkProxySettings: this.networkProxySettingsResolver?.(),
              signal: this.claudeUsageFetchSignal(signal)
            }),
        codexFetchGated
          ? Promise.resolve(previousState.codex as ProviderRateLimits)
          : (missingWslCodexHome ??
            fetchCodexRateLimits({
              codexHomePath,
              readingAccount: codexHome?.readingAccount,
              networkProxySettings: this.networkProxySettingsResolver?.(),
              signal
            })),
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
        disabled.has('kimi')
          ? Promise.resolve(this.disabledUsageProviderSnapshot('kimi'))
          : this.fetchKimiWithResolvedHome(),
        // Why a call-site gate, like OpenCode Go: an emptied config still enters the fetcher,
        // so the switch would be enforced by that fetcher's own short-circuit, not by the switch.
        disabled.has('minimax')
          ? Promise.resolve(this.disabledUsageProviderSnapshot('minimax'))
          : miniMaxConfigResult.error
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
      codexHomePath,
      codexGeneration,
      opencodeConfigChanged,
      opencodeGeneration,
      miniMaxConfigChanged,
      miniMaxGeneration,
      zcodeConfigChanged,
      zcodeGeneration,
      forkProviderCycle,
      claudeFetchGated,
      results: [claudeResult, codexResult, opencodeGoResult, kimiResult, miniMaxResult],
      grokResultPromise,
      cursorResultPromise,
      zcodeResultPromise
    }
  }
}
