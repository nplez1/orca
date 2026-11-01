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
import type { DisableableUsageProviderId } from '../../../shared/usage-provider-enablement'
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

export type ForkProviderCycleInput = {
  disabled: ReadonlySet<DisableableUsageProviderId>
  resolveConfigs: () => ForkProviderCycleResolvedConfigs
  syncGenerations: (fingerprints: {
    deepSeek: string
    fireworks: string
    deepInfra: string
    copilot: string
  }) => ForkProviderCycleGenerations
  apiKeyCredentialError: (
    provider: 'deepseek' | 'fireworks' | 'deepinfra' | 'copilot',
    message: string
  ) => ProviderRateLimits
}

export type ForkProviderCycleSlot = {
  configChanged: boolean
  generation: number
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

function trackForkProviderFetch(
  provider: 'deepseek' | 'fireworks' | 'deepinfra' | 'copilot',
  disabled: ReadonlySet<DisableableUsageProviderId>,
  load: () => Promise<ProviderRateLimits>
): Promise<SettledProviderResult> {
  return trackSettledProviderResult(
    disabled.has(provider) ? Promise.resolve(disabledUsageProviderSnapshot(provider)) : load()
  )
}

/** Resolves the fork's four API-key providers onto the sibling lane: credential
 *  resolution and generation stamps at prepare time, one settled promise each so
 *  the positional tuple stays upstream's. A disabled provider never reaches its
 *  fetch or its gh probe. */
export function prepareForkProviderCycle(input: ForkProviderCycleInput): ForkProviderCyclePrepared {
  const { disabled } = input
  const configs = input.resolveConfigs()
  // Why synchronous: the gh probe is refreshed out of band, so a subprocess never sits
  // on the fetch critical path where its latency would stall every other provider.
  const copilotGhResult = disabled.has('copilot') ? null : readCopilotGhCredentialsForCycle()
  const copilotCredentials = resolveCopilotCycleCredentials(configs.copilot, copilotGhResult)
  const generations = input.syncGenerations({
    deepSeek: `${configs.deepSeek.config.apiKey}|${configs.deepSeek.error ?? ''}`,
    fireworks: `${configs.fireworks.config.apiKey}|${configs.fireworks.config.accountIdOverride ?? ''}|${configs.fireworks.error ?? ''}`,
    deepInfra: `${configs.deepInfra.config.apiKey}|${configs.deepInfra.error ?? ''}`,
    copilot: copilotCredentials.configHash
  })
  return {
    deepSeek: {
      configChanged: generations.deepSeek.changed,
      generation: generations.deepSeek.generation,
      resultPromise: trackForkProviderFetch('deepseek', disabled, () =>
        configs.deepSeek.error
          ? Promise.resolve(input.apiKeyCredentialError('deepseek', configs.deepSeek.error))
          : fetchDeepSeekRateLimits({ apiKey: configs.deepSeek.config.apiKey })
      )
    },
    fireworks: {
      configChanged: generations.fireworks.changed,
      generation: generations.fireworks.generation,
      resultPromise: trackForkProviderFetch('fireworks', disabled, () =>
        configs.fireworks.error
          ? Promise.resolve(input.apiKeyCredentialError('fireworks', configs.fireworks.error))
          : fetchFireworksRateLimits({
              apiKey: configs.fireworks.config.apiKey,
              accountIdOverride: configs.fireworks.config.accountIdOverride
            })
      )
    },
    deepInfra: {
      configChanged: generations.deepInfra.changed,
      generation: generations.deepInfra.generation,
      resultPromise: trackForkProviderFetch('deepinfra', disabled, () =>
        configs.deepInfra.error
          ? Promise.resolve(input.apiKeyCredentialError('deepinfra', configs.deepInfra.error))
          : fetchDeepInfraRateLimits({ apiKey: configs.deepInfra.config.apiKey })
      )
    },
    copilot: {
      configChanged: generations.copilot.changed,
      generation: generations.copilot.generation,
      resultPromise: trackForkProviderFetch('copilot', disabled, () =>
        configs.copilot.error
          ? Promise.resolve(input.apiKeyCredentialError('copilot', configs.copilot.error))
          : fetchCopilotRateLimits({
              token: copilotCredentials.token,
              enterpriseSlug: copilotCredentials.enterpriseSlug,
              source: copilotCredentials.source
            })
      )
    }
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
