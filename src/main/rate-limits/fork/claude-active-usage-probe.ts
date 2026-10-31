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
  const openRetryAtMs = options.usageEndpointRetryAtMs
  const retryAtMs = openRetryAtMs && openRetryAtMs > Date.now() ? openRetryAtMs : null
  return {
    ...reading,
    usageMetadata: {
      ...reading.usageMetadata,
      ...(retryAtMs ? { retryAtMs } : {}),
      authProvenance: authPreparation?.provenance ?? 'system'
    }
  }
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
export function retryAfterBlocksProviderLane(
  provider: ProviderRateLimits['provider'],
  probeAvailable: boolean
): boolean {
  // The probe never asks the endpoint, so its Retry-After only gates the endpoint, not the lane.
  return !(provider === 'claude' && probeAvailable)
}
