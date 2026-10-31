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
  return reading
    ? {
        ...reading,
        usageMetadata: {
          ...reading.usageMetadata,
          authProvenance: authPreparation?.provenance ?? 'system'
        }
      }
    : null
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
    attemptedSources: ['oauth'],
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
