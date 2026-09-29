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
import { fetchMiniMaxRateLimits } from '../minimax/minimax-fetcher'
import { createHash } from 'node:crypto'
import { fetchOpenCodeGoUsage } from '../opencode-go-usage-source-selection'
import { RateLimitServiceFetchPolicy } from './service-fetch-policy'
import type { FetchAllCyclePrepared, ProviderRateLimits } from './service-types'

export abstract class RateLimitServiceFullCyclePreparation extends RateLimitServiceFetchPolicy {
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
    const openCodeGoConfig = disabled.has('opencode-go') ? null : this.openCodeGoConfigResolver?.()
    const cookie = openCodeGoConfig?.sessionCookie ?? ''
    const workspaceIdOverride = openCodeGoConfig?.workspaceIdOverride ?? ''
    const openCodeGoApiKey = openCodeGoConfig?.apiKey ?? ''
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
    const copilotStoredCredentials =
      copilotConfigResult.config.token && copilotConfigResult.config.enterpriseSlug
        ? {
            token: copilotConfigResult.config.token,
            enterpriseSlug: copilotConfigResult.config.enterpriseSlug
          }
        : null
    // Why stored wins: it is the deliberate override, and the paste form exists for
    // accounts gh cannot serve at all.
    const copilotCredentials =
      copilotStoredCredentials ??
      // Why no token here: gh supplies its own sign-in; the stored token is only ever an
      // explicit override passed to gh as GH_TOKEN.
      (copilotGhResult?.status === 'ok'
        ? { token: '', enterpriseSlug: '', source: 'user-entitlement' as const }
        : { token: '', enterpriseSlug: '', source: 'enterprise-billing' as const })
    const copilotToken = copilotCredentials.token
    const copilotEnterpriseSlug = copilotCredentials.enterpriseSlug
    const copilotSource =
      'source' in copilotCredentials ? copilotCredentials.source : 'enterprise-billing'
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

    const currentCopilotConfigHash = `${copilotToken}|${copilotEnterpriseSlug}|${copilotSource}|${copilotConfigResult.error ?? ''}`
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
      grok: this.withFetchingStatus(previousState.grok, 'grok'),
      cursor: this.withFetchingStatus(previousState.cursor, 'cursor'),
      // Why: a disabled provider holds no snapshot at all, so a prior reading cannot linger.
      ...this.disabledUsageProviderStateOverrides()
    })

    // Why: the Cursor probe reads the macOS Keychain, so it is awaited inside the
    // provider's own promise instead of blocking the rest of the cycle on it.
    const cursorResultPromise = disabled.has('cursor')
      ? Promise.resolve(this.disabledUsageProviderSnapshot('cursor')).then(
          (value) => ({ status: 'fulfilled', value }) as const
        )
      : readCursorAuthSession()
          .then((authReadResult) => {
            this.cursorAuthConfigured = authReadResult.status === 'ok'
            return fetchCursorRateLimits({ signal, authReadResult })
          })
          .then(
            (value) => ({ status: 'fulfilled', value }) as const,
            (reason) => ({ status: 'rejected', reason }) as const
          )

    const missingWslCodexHome =
      codexFetchGated || codexHomePath ? null : this.getMissingWslCodexHomeResult(codexTarget)
    // Why: reading Grok's auth file is the credential import, so a disabled Grok never reaches it.
    const grokResultPromise = grokAuthReadResult
      ? fetchGrokRateLimits({ signal, authReadResult: grokAuthReadResult }).then(
          (value) => ({ status: 'fulfilled', value }) as const,
          (reason) => ({ status: 'rejected', reason }) as const
        )
      : Promise.resolve(this.disabledUsageProviderSnapshot('grok')).then(
          (value) => ({ status: 'fulfilled', value }) as const
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
            allowPtyFallback: this.shouldAllowCodexPtyFallback(),
            signal
          })),
      this.fetchUnlessDisabled('gemini', () => fetchGeminiRateLimits(geminiCliOAuthEnabled)),
      disabled.has('opencode-go')
        ? Promise.resolve(this.disabledUsageProviderSnapshot('opencode-go'))
        : fetchOpenCodeGoUsage({
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
      grokResultPromise,
      cursorResultPromise
    }
  }
}
