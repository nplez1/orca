import { fetchClaudeRateLimits } from '../claude-fetcher'
import { fetchCodexRateLimits } from '../codex-fetcher'
import { fetchDeepSeekRateLimits } from '../deepseek/deepseek-fetcher'
import { fetchFireworksRateLimits } from '../fireworks/fireworks-fetcher'
import { fetchCopilotRateLimits } from '../copilot/copilot-fetcher'
import { readCopilotGhCredentialsForCycle } from '../copilot/copilot-gh-credentials'
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
import { RateLimitServiceCycleFetchState } from './service-cycle-fetch-state'
import { resolveCopilotCycleCredentials } from './service-copilot-cycle-credentials'
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
    // Why: capture before the resolver await so an account switch during it invalidates both the snapshot and the state apply.
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
    const previousState = this.state
    // Why: a skipped Codex poll must not stop the other providers' cycle, so gate
    // only the Codex slot instead of returning early (#STA-4422).
    // Why: resolveCodexHome probes credential homes, so a disabled Codex skips it entirely.
    const codexHome = disabled.has('codex') ? null : this.resolveCodexHome(codexTarget)
    const codexFetchGated = disabled.has('codex') || codexHome?.skip === true
    const codexHomePath = codexHome?.homePath ?? null
    const codexStateBeforeFetch =
      previousState.codex?.status === 'fetching' ? null : previousState.codex
    const codexProvenance = codexFetchGated
      ? null
      : this.getCodexProvenance(codexTarget, codexHomePath)
    const codexGeneration = this.codexFetchGeneration
    const openCodeGoConfig = disabled.has('opencode-go') ? null : this.resolveOpenCodeGoConfig()
    const cookie = openCodeGoConfig?.sessionCookie ?? ''
    const workspaceIdOverride = openCodeGoConfig?.workspaceIdOverride ?? ''
    const openCodeGoApiKey = openCodeGoConfig?.apiKey ?? ''
    const openCodeGoApiKeyError = openCodeGoConfig?.apiKeyError ?? null
    const openCodeGoApiKeyReadSkipped = openCodeGoConfig?.apiKeyReadSkipped ?? false
    const miniMaxConfigResult = this.resolveMiniMaxConfig({ disabled: disabled.has('minimax') })
    const miniMaxCookie = miniMaxConfigResult.config.sessionCookie
    const miniMaxGroupId = miniMaxConfigResult.config.groupId
    const miniMaxModels = miniMaxConfigResult.config.models
    const miniMaxEndpoint = miniMaxConfigResult.config.endpoint
    const miniMaxApiKey = miniMaxConfigResult.config.apiKey
    const deepSeekConfigResult = this.resolveDeepSeekConfig({
      disabled: disabled.has('deepseek')
    })
    const deepSeekApiKey = deepSeekConfigResult.config.apiKey
    const fireworksConfigResult = this.resolveFireworksConfig({
      disabled: disabled.has('fireworks')
    })
    const fireworksApiKey = fireworksConfigResult.config.apiKey
    const fireworksAccountIdOverride = fireworksConfigResult.config.accountIdOverride
    const copilotConfigResult = this.resolveCopilotConfig({ disabled: disabled.has('copilot') })
    // Why synchronous: the gh probe is refreshed out of band, so a subprocess never sits
    // on the fetch critical path where its latency would stall every other provider.
    const copilotGhResult = disabled.has('copilot') ? null : readCopilotGhCredentialsForCycle()
    const copilotCredentials = resolveCopilotCycleCredentials(copilotConfigResult, copilotGhResult)
    const copilotToken = copilotCredentials.token
    const copilotEnterpriseSlug = copilotCredentials.enterpriseSlug
    const copilotSource = copilotCredentials.source
    const geminiCliOAuthEnabled = disabled.has('gemini')
      ? false
      : (this.geminiCliOAuthEnabledResolver?.() ?? false)
    // Why: getState() is hot (renderer pushes + mobile snapshots); keep Grok's sync auth-file probe on fetch cycles instead.
    const grokAuthReadResult = disabled.has('grok') ? null : readGrokAuthSession()
    this.grokAuthConfigured = disabled.has('grok') ? false : grokAuthReadResult?.status === 'ok'

    // Discard stale data on config change — it belongs to a different session/workspace.
    // Digest, not the key: this string only has to change when the account does.
    const apiKeyFingerprint = openCodeGoApiKey
      ? createHash('sha256').update(openCodeGoApiKey).digest('hex')
      : ''
    const currentConfigHash = `${cookie}|${workspaceIdOverride}|${apiKeyFingerprint}|${openCodeGoApiKeyError ?? ''}`
    const opencodeConfigChanged = currentConfigHash !== this.lastOpencodeConfigHash
    const opencodeGeneration = this.syncOpencodeFetchGeneration(currentConfigHash)

    const currentMiniMaxConfigHash = `${miniMaxCookie}|${miniMaxGroupId}|${miniMaxModels}|${miniMaxEndpoint}|${miniMaxApiKey}|${miniMaxConfigResult.error ?? ''}`
    const miniMaxConfigChanged = currentMiniMaxConfigHash !== this.lastMiniMaxConfigHash
    const miniMaxGeneration = this.syncMiniMaxFetchGeneration(currentMiniMaxConfigHash)

    const antigravityUsageEnabled = this.antigravityUsageEnabledResolver?.() ?? true

    const zcodePlanConfigResult = this.resolveZcodePlanConfig()
    const zcodePlanApiKey = zcodePlanConfigResult.config.apiKey
    // Why digest, not the key: this string only has to change when the credential does.
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
    const currentDeepSeekConfigHash = `${deepSeekApiKey}|${deepSeekConfigResult.error ?? ''}`
    const deepSeekConfigChanged = currentDeepSeekConfigHash !== this.lastDeepSeekConfigHash
    const deepSeekGeneration = this.syncDeepSeekFetchGeneration(currentDeepSeekConfigHash)

    const currentFireworksConfigHash = `${fireworksApiKey}|${fireworksAccountIdOverride ?? ''}|${fireworksConfigResult.error ?? ''}`
    const fireworksConfigChanged = currentFireworksConfigHash !== this.lastFireworksConfigHash
    const fireworksGeneration = this.syncFireworksFetchGeneration(currentFireworksConfigHash)

    const currentCopilotConfigHash = copilotCredentials.configHash
    const copilotConfigChanged = currentCopilotConfigHash !== this.lastCopilotConfigHash
    const copilotGeneration = this.syncCopilotFetchGeneration(currentCopilotConfigHash)

    this.markProvidersFetching({
      previousState,
      codexFetchGated,
      codexStateBeforeFetch,
      antigravityUsageEnabled,
      changed: {
        opencodeGo: opencodeConfigChanged,
        minimax: miniMaxConfigChanged,
        deepseek: deepSeekConfigChanged,
        fireworks: fireworksConfigChanged,
        copilot: copilotConfigChanged,
        zcode: zcodeConfigChanged
      }
    })

    // Why its own promise: the keychain read and the desktop state.vscdb read
    // (on its worker thread) are both async and must not delay other providers.
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
    const antigravityResultPromise = (
      antigravityUsageEnabled
        ? fetchAntigravityRateLimits({ signal })
        : Promise.resolve(previousState.antigravity ?? antigravityUsageDisabledSnapshot())
    ).then(
      (value) => ({ status: 'fulfilled', value }) as const,
      (reason) => ({ status: 'rejected', reason }) as const
    )

    const missingWslCodexHome =
      codexFetchGated || codexHomePath ? null : this.getMissingWslCodexHomeResult(codexTarget)
    // Why: reading Grok's auth file is the credential import, so a disabled Grok never reaches it.
    const grokResultPromise = grokAuthReadResult
      ? trackSettledProviderResult(
          fetchGrokRateLimits({ signal, authReadResult: grokAuthReadResult })
        )
      : trackSettledProviderResult(Promise.resolve(this.disabledUsageProviderSnapshot('grok')))

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
        : disabled.has('claude')
          ? Promise.resolve(this.disabledUsageProviderSnapshot('claude'))
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
            signal
          })),
      this.fetchUnlessDisabled('gemini', () => fetchGeminiRateLimits(geminiCliOAuthEnabled)),
      this.fetchUnlessDisabled('opencode-go', () =>
        fetchOpenCodeGoUsage({
          settingsApiKey: openCodeGoApiKey,
          // Why here: the key can also come from the environment or OpenCode's
          // own store, so presence is only known once the fetch resolves it.
          onApiKeyResolved: (resolution) => {
            // Why: a credential change mid-fetch bumps the generation; its stale presence must not win.
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
        })
      ),
      this.fetchKimiWithResolvedHome(),
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
            }),
      disabled.has('deepseek')
        ? Promise.resolve(this.disabledUsageProviderSnapshot('deepseek'))
        : deepSeekConfigResult.error
          ? Promise.resolve(this.getApiKeyCredentialError('deepseek', deepSeekConfigResult.error))
          : fetchDeepSeekRateLimits({ apiKey: deepSeekApiKey }),
      disabled.has('fireworks')
        ? Promise.resolve(this.disabledUsageProviderSnapshot('fireworks'))
        : fireworksConfigResult.error
          ? Promise.resolve(this.getApiKeyCredentialError('fireworks', fireworksConfigResult.error))
          : fetchFireworksRateLimits({
              apiKey: fireworksApiKey,
              accountIdOverride: fireworksAccountIdOverride
            }),
      disabled.has('copilot')
        ? Promise.resolve(this.disabledUsageProviderSnapshot('copilot'))
        : copilotConfigResult.error
          ? Promise.resolve(this.getApiKeyCredentialError('copilot', copilotConfigResult.error))
          : fetchCopilotRateLimits({
              token: copilotToken,
              enterpriseSlug: copilotEnterpriseSlug,
              source: copilotSource
            })
    ])

    if (signal.aborted) {
      return null
    }
    // Why: the decrypt error only replaces a result with no usage and no diagnosis of its own; a real cookie error stays visible.
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
      grokResultPromise,
      cursorResultPromise,
      zcodeResultPromise,
      antigravityResultPromise
    }
  }
}
