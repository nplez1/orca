import { providerResultSnapshot } from './service-provider-result-snapshot'
import type { ProviderRateLimits } from './service-types'

export type SettledProviderResult =
  | { status: 'fulfilled'; value: ProviderRateLimits }
  | { status: 'rejected'; reason: unknown }

/**
 * Collapses a provider that resolves on its own promise (outside the main
 * `Promise.allSettled` tuple) into a publishable snapshot.
 */
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
