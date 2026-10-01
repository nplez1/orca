import type { ProviderRateLimits } from './service-types'

/** Fields a provider reports explicitly in its rejected-fetch snapshot (e.g. an empty monthly window). */
export type ProviderSnapshotFallback = Pick<ProviderRateLimits, 'monthly'>

/**
 * Collapses a settled fetch into a publishable snapshot: a fulfilled result passes
 * through, a rejection becomes an error snapshot.
 */
export function providerResultSnapshot(
  provider: ProviderRateLimits['provider'],
  settled: PromiseSettledResult<ProviderRateLimits>,
  fallback?: ProviderSnapshotFallback
): ProviderRateLimits {
  if (settled.status === 'fulfilled') {
    return settled.value
  }
  return {
    provider,
    session: null,
    weekly: null,
    ...fallback,
    updatedAt: Date.now(),
    error: settled.reason instanceof Error ? settled.reason.message : 'Unknown error',
    status: 'error'
  }
}
