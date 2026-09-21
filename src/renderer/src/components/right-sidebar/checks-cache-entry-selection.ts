import type { CacheEntry } from '@/store/github/cache-model'

/**
 * Why: fetchPRChecks writes the head-sha keyed entry and only reads the legacy
 * (head-less) key as a fallback, so every reader must resolve both the same way
 * or its freshness gate silently never sees the write.
 */
export function selectChecksCacheEntry<T>(
  checksCache: Readonly<Record<string, CacheEntry<T> | undefined>>,
  withHeadShaKey: string,
  legacyKey: string
): CacheEntry<T> | undefined {
  return checksCache[withHeadShaKey] ?? checksCache[legacyKey]
}
