import type { ProviderRateLimits, UsageRateLimitMetadata } from '../../../shared/rate-limit-types'
import type { ClaudeRateLimitFetchOptions } from '../claude-usage-fetch-options'
import { makeClaudeUsageResult } from '../claude-usage-result'
import { readClaudeUsageFromCli, type ClaudeUsageProbeDeps } from './claude-cli-usage-probe'

/**
 * Read the active account's usage from the Claude CLI instead of the usage endpoint.
 *
 * Null means this account has to be read the other way: an API-key login has no plan limits to
 * report, a WSL account's login lives in the guest, and a profile Orca already knows is unusable
 * must not be handed to a CLI at all.
 */
export async function readActiveClaudeUsageFromProbe(
  options: ClaudeRateLimitFetchOptions | undefined,
  deps?: ClaudeUsageProbeDeps
): Promise<ProviderRateLimits | null> {
  const authPreparation = options?.authPreparation
  if (!options?.allowUsagePanelSupplement || authPreparation?.usageError) {
    return null
  }
  if (authPreparation?.runtime === 'wsl') {
    return null
  }
  if (options.signal?.aborted) {
    return null
  }
  const reading = await readClaudeUsageFromCli(
    {
      envPatch: authPreparation?.envPatch,
      ...(options.signal ? { signal: options.signal } : {})
    },
    deps
  )
  if (!reading) {
    return null
  }
  // Why keep it: the endpoint's wait is still the endpoint's, and carrying it means a probe that
  // fails inside that window cannot spend the request the endpoint asked Orca to hold.
  const retryAtMs = openEndpointRetryAtMs(options)
  return {
    ...reading,
    usageMetadata: {
      ...reading.usageMetadata,
      ...(retryAtMs ? { retryAtMs } : {}),
      authProvenance: authPreparation?.provenance ?? 'system'
    }
  }
}

/** The endpoint's own Retry-After, while it is still open. */
export function openEndpointRetryAtMs(
  options: ClaudeRateLimitFetchOptions | undefined
): number | null {
  const retryAtMs = options?.usageEndpointRetryAtMs
  return retryAtMs && retryAtMs > Date.now() ? retryAtMs : null
}

/**
 * The probe could not answer and the endpoint's own Retry-After is still open: report the wait
 * rather than spending another request on a route that asked Orca to stop.
 */
export function claudeUsageEndpointGatedResult(
  metadata: UsageRateLimitMetadata,
  retryAtMs: number
): ProviderRateLimits {
  return makeClaudeUsageResult('error', 'Claude usage is rate limited right now.', {
    ...metadata,
    failureKind: 'rate-limited',
    // The CLI is what this cycle tried; the endpoint was held by its own Retry-After.
    attemptedSources: ['cli'],
    retryAtMs
  })
}

/** True while a provider's open Retry-After must block its whole lane. */
export function retryAfterBlocksProviderLane(provider: ProviderRateLimits['provider']): boolean {
  // fork-comment-ok: fork-only behaviour; the why must sit above the code a sync rewrites.
  // Why never Claude: the header probe answers without the endpoint and needs no platform, so an
  // endpoint Retry-After gates that one request and never the lane.
  return provider !== 'claude'
}
