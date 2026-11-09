import { fetchDeepSeekRateLimits } from '../deepseek/deepseek-fetcher'
import { fetchDeepInfraRateLimits } from '../deepinfra/deepinfra-fetcher'
import { fetchFireworksRateLimits } from '../fireworks/fireworks-fetcher'
import { fetchCopilotRateLimits } from '../copilot/copilot-fetcher'
import { readCopilotGhCredentialsForCycle } from '../copilot/copilot-gh-credentials'
import { resolveCopilotCycleCredentials } from '../service/service-copilot-cycle-credentials'
import {
  settleSiblingProviderResult,
  trackSettledProviderResult,
  type SettledProviderResult
} from '../service/service-sibling-provider-result'
import { disabledUsageProviderSnapshot } from '../service/service-state'
import { usageCredentialFingerprint } from './usage-credential-fingerprint'
import type { DisableableUsageProviderId } from '../../../shared/usage-provider-enablement'
import type { ForkUsageProviderId } from '../../../shared/usage-providers/usage-provider-manifest'
import type {
  CopilotResolvedConfig,
  DeepInfraResolvedConfig,
  DeepSeekResolvedConfig,
  FireworksResolvedConfig,
  ProviderRateLimits
} from '../service/service-types'

export type ForkProviderGenerationStamp = {
  generation: number
  changed: boolean
}

export type ForkProviderCycleResolvedConfigs = {
  deepSeek: DeepSeekResolvedConfig
  fireworks: FireworksResolvedConfig
  deepInfra: DeepInfraResolvedConfig
  copilot: CopilotResolvedConfig
}

export type ForkProviderCycleGenerations = {
  deepSeek: ForkProviderGenerationStamp
  fireworks: ForkProviderGenerationStamp
  deepInfra: ForkProviderGenerationStamp
  copilot: ForkProviderGenerationStamp
}

export type ForkProviderCyclePrevious = Record<ForkProviderId, ProviderRateLimits | null>

export type ForkProviderCycleInput = {
  disabled: ReadonlySet<DisableableUsageProviderId>
  signal: AbortSignal
  /** A user-triggered refresh passes an open Retry-After; an automated cycle does not. */
  force: boolean
  previous: ForkProviderCyclePrevious
  isRetryAfterActive: (limits: ProviderRateLimits | null) => boolean
  resolveConfigs: () => ForkProviderCycleResolvedConfigs
  syncGenerations: (fingerprints: {
    deepSeek: string
    fireworks: string
    deepInfra: string
    copilot: string
  }) => ForkProviderCycleGenerations
  apiKeyCredentialError: (provider: ForkUsageProviderId, message: string) => ProviderRateLimits
}

export type ForkProviderCycleSlot = {
  configChanged: boolean
  generation: number
  /** No request was made this cycle because the endpoint's own Retry-After is still open. */
  fetchGated: boolean
  resultPromise: Promise<SettledProviderResult>
}

export type ForkProviderCyclePrepared = {
  deepSeek: ForkProviderCycleSlot
  fireworks: ForkProviderCycleSlot
  deepInfra: ForkProviderCycleSlot
  copilot: ForkProviderCycleSlot
}

export type ForkProviderCycleSettled = {
  deepseek: ProviderRateLimits
  fireworks: ProviderRateLimits
  deepinfra: ProviderRateLimits
  copilot: ProviderRateLimits
}

type ForkProviderId = ForkUsageProviderId

function trackForkProviderFetch(
  provider: ForkProviderId,
  disabled: ReadonlySet<DisableableUsageProviderId>,
  load: () => Promise<ProviderRateLimits>
): Promise<SettledProviderResult> {
  return trackSettledProviderResult(
    disabled.has(provider) ? Promise.resolve(disabledUsageProviderSnapshot(provider)) : load()
  )
}

function prepareForkProviderSlot(args: {
  provider: ForkProviderId
  disabled: ReadonlySet<DisableableUsageProviderId>
  force: boolean
  previous: ProviderRateLimits | null
  generation: ForkProviderGenerationStamp
  isRetryAfterActive: (limits: ProviderRateLimits | null) => boolean
  load: () => Promise<ProviderRateLimits>
}): ForkProviderCycleSlot {
  const { provider, disabled, generation, previous } = args
  // Why: hitting an endpoint before its Retry-After expires burns budget and keeps the 429 window
  // alive. A credential change outranks the wait — that wait belonged to the old key.
  const retryAfterOpen =
    !args.force &&
    !disabled.has(provider) &&
    !generation.changed &&
    args.isRetryAfterActive(previous)
  const gatedPrevious = retryAfterOpen ? previous : null
  return {
    configChanged: generation.changed,
    generation: generation.generation,
    fetchGated: gatedPrevious !== null,
    resultPromise: gatedPrevious
      ? trackSettledProviderResult(Promise.resolve(gatedPrevious))
      : trackForkProviderFetch(provider, disabled, args.load)
  }
}

/** Resolves the fork's four API-key providers onto the sibling lane: credential
 *  resolution and generation stamps at prepare time, one settled promise each so
 *  the positional tuple stays upstream's. A disabled provider never reaches its
 *  fetch or its gh probe. */
export function prepareForkProviderCycle(input: ForkProviderCycleInput): ForkProviderCyclePrepared {
  const { disabled, previous, isRetryAfterActive } = input
  const configs = input.resolveConfigs()
  // Why synchronous: the gh probe is refreshed out of band, so a subprocess never sits
  // on the fetch critical path where its latency would stall every other provider.
  const copilotGhResult = disabled.has('copilot') ? null : readCopilotGhCredentialsForCycle()
  const copilotCredentials = resolveCopilotCycleCredentials(configs.copilot, copilotGhResult)
  // Why hashed: these fingerprints are only ever compared, so the raw key never has to be retained.
  const generations = input.syncGenerations({
    deepSeek: `${usageCredentialFingerprint(configs.deepSeek.config.apiKey)}|${configs.deepSeek.error ?? ''}`,
    fireworks: `${usageCredentialFingerprint(configs.fireworks.config.apiKey)}|${configs.fireworks.config.accountIdOverride ?? ''}|${configs.fireworks.error ?? ''}`,
    deepInfra: `${usageCredentialFingerprint(configs.deepInfra.config.apiKey)}|${configs.deepInfra.error ?? ''}`,
    copilot: copilotCredentials.configHash
  })
  const slot = (
    provider: ForkProviderId,
    generation: ForkProviderGenerationStamp,
    load: () => Promise<ProviderRateLimits>
  ): ForkProviderCycleSlot =>
    prepareForkProviderSlot({
      provider,
      disabled,
      force: input.force,
      previous: previous[provider],
      generation,
      isRetryAfterActive,
      load
    })
  return {
    deepSeek: slot('deepseek', generations.deepSeek, () =>
      configs.deepSeek.error
        ? Promise.resolve(input.apiKeyCredentialError('deepseek', configs.deepSeek.error))
        : fetchDeepSeekRateLimits({
            apiKey: configs.deepSeek.config.apiKey,
            signal: input.signal
          })
    ),
    fireworks: slot('fireworks', generations.fireworks, () =>
      configs.fireworks.error
        ? Promise.resolve(input.apiKeyCredentialError('fireworks', configs.fireworks.error))
        : fetchFireworksRateLimits({
            apiKey: configs.fireworks.config.apiKey,
            accountIdOverride: configs.fireworks.config.accountIdOverride,
            signal: input.signal
          })
    ),
    deepInfra: slot('deepinfra', generations.deepInfra, () =>
      configs.deepInfra.error
        ? Promise.resolve(input.apiKeyCredentialError('deepinfra', configs.deepInfra.error))
        : fetchDeepInfraRateLimits({
            apiKey: configs.deepInfra.config.apiKey,
            signal: input.signal
          })
    ),
    copilot: slot('copilot', generations.copilot, () =>
      configs.copilot.error
        ? Promise.resolve(input.apiKeyCredentialError('copilot', configs.copilot.error))
        : fetchCopilotRateLimits({
            token: copilotCredentials.token,
            enterpriseSlug: copilotCredentials.enterpriseSlug,
            source: copilotCredentials.source,
            signal: input.signal
          })
    )
  }
}

/** Collapses the fork's four settled sibling promises into publishable snapshots. */
export async function applyForkProviderCycle(
  prepared: ForkProviderCyclePrepared
): Promise<ForkProviderCycleSettled> {
  const [deepSeek, fireworks, deepInfra, copilot] = await Promise.all([
    prepared.deepSeek.resultPromise,
    prepared.fireworks.resultPromise,
    prepared.deepInfra.resultPromise,
    prepared.copilot.resultPromise
  ])
  return {
    deepseek: settleSiblingProviderResult('deepseek', deepSeek),
    fireworks: settleSiblingProviderResult('fireworks', fireworks),
    deepinfra: settleSiblingProviderResult('deepinfra', deepInfra),
    copilot: settleSiblingProviderResult('copilot', copilot)
  }
}
