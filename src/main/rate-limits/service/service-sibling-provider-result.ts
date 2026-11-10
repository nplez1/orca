import { providerResultSnapshot } from './service-provider-result-snapshot'
import type { ProviderRateLimits } from '../../../shared/rate-limit-types'

export type SettledProviderResult =
  | { status: 'fulfilled'; value: ProviderRateLimits }
  | { status: 'rejected'; reason: unknown }

export function settleSiblingProviderFetch(
  pending: Promise<ProviderRateLimits>
): Promise<SettledProviderResult> {
  return pending.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason })
  )
}

export function settleSiblingProviderResult(
  provider: ProviderRateLimits['provider'],
  settled: SettledProviderResult
): ProviderRateLimits {
  return providerResultSnapshot(provider, settled)
}

/** Wraps a provider fetch so a late rejection becomes data, not a cycle failure. */
export function trackSettledProviderResult(
  promise: Promise<ProviderRateLimits>
): Promise<SettledProviderResult> {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }) as const,
    (reason) => ({ status: 'rejected', reason }) as const
  )
}
