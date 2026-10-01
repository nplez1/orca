import type { CopilotGhCredentialsResult } from '../copilot/copilot-gh-credentials'
import type { CopilotResolvedConfig } from './service-types'

export type CopilotCycleCredentials = {
  token: string
  enterpriseSlug: string
  source: 'enterprise-billing' | 'user-entitlement'
  /** Changes whenever the fetch inputs do, so an in-flight result can be discarded. */
  configHash: string
}

/** Resolves the credentials a Copilot fetch runs with, fingerprinted for config-change detection. */
export function resolveCopilotCycleCredentials(
  resolvedConfig: CopilotResolvedConfig,
  ghResult: CopilotGhCredentialsResult | null
): CopilotCycleCredentials {
  const { config, error } = resolvedConfig
  // Why stored wins: it is the deliberate override, and the paste form exists for
  // accounts gh cannot serve at all.
  if (config.token && config.enterpriseSlug) {
    return {
      token: config.token,
      enterpriseSlug: config.enterpriseSlug,
      source: 'enterprise-billing',
      configHash: copilotConfigHash(
        config.token,
        config.enterpriseSlug,
        'enterprise-billing',
        error
      )
    }
  }
  // Why no token here: gh supplies its own sign-in; the stored token is only ever an
  // explicit override passed to gh as GH_TOKEN.
  const source = ghResult?.status === 'ok' ? 'user-entitlement' : 'enterprise-billing'
  return {
    token: '',
    enterpriseSlug: '',
    source,
    configHash: copilotConfigHash('', '', source, error)
  }
}

function copilotConfigHash(
  token: string,
  enterpriseSlug: string,
  source: string,
  error: string | null
): string {
  return `${token}|${enterpriseSlug}|${source}|${error ?? ''}`
}
