import type { AiVaultListResult } from '../../shared/ai-vault-types'
import {
  aiVaultCachedDepthServes,
  type AiVaultSessionDepth
} from '../../shared/ai-vault-session-depth'

/** Structurally the caller's cache entry; declared here so upstream's own type declaration stands. */
type LocalCacheEntry = {
  key: string
  depth: AiVaultSessionDepth
  result: AiVaultListResult
  expiresAt: number
}

/**
 * An unbounded list holds every scope at every depth, but it is stored without one, so
 * a scoped request rides on it rather than re-reading the same rows.
 */
export function localCacheHit(
  cached: LocalCacheEntry | null,
  key: string,
  unboundedKey: string | null,
  depth: AiVaultSessionDepth,
  scopePaths: readonly string[] | undefined,
  now: number
): LocalCacheEntry | null {
  if (!cached || cached.expiresAt <= now) {
    return null
  }
  // Why the unbounded bypass: an unbounded scan holds every scope at every depth, so a scoped
  // bounded request is answered from it rather than re-read (the renderer's result cache is the
  // one place that must keep the requested depth, because it stores the truncated answer).
  if (cached.depth !== 'unlimited' && !aiVaultCachedDepthServes(cached.depth, depth, scopePaths)) {
    return null
  }
  if (cached.key === key) {
    return cached
  }
  return unboundedKey !== null && cached.depth === 'unlimited' && cached.key === unboundedKey
    ? cached
    : null
}
