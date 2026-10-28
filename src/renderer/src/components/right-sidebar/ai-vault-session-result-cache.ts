import type { AiVaultListResult } from '../../../../shared/ai-vault-types'
import type { ExecutionHostScope } from '../../../../shared/execution-host'
import {
  aiVaultCachedDepthServes,
  truncateAiVaultListResult
} from '../../../../shared/ai-vault-session-depth'
import type { AiVaultSessionLimit } from './ai-vault-session-limit'
import { aiVaultSessionKeyScopePaths } from './ai-vault-session-limit'

const MAX_CACHED_SESSION_SCOPES = 8

type CachedSessionResult = {
  executionHostScope: ExecutionHostScope
  limit: AiVaultSessionLimit
  result: AiVaultListResult
}

const cachedSessionResults = new Map<string, CachedSessionResult>()

export function aiVaultSessionResultCacheKey(
  executionHostScope: ExecutionHostScope,
  scopePaths: readonly string[],
  /** The depth: an unbounded answer holds every scope already, so it keys without one. */
  limit: AiVaultSessionLimit,
  /** The host-applied filter; a filtered listing is not the unfiltered one. */
  query = ''
): string {
  const applied = aiVaultSessionKeyScopePaths(scopePaths, limit)
  // JSON keeps the parts unambiguous: a path may legally contain any separator.
  return JSON.stringify([executionHostScope, ...[...new Set(applied)].sort(), query])
}

export function readCachedAiVaultSessionResult(args: {
  key: string
  limit: AiVaultSessionLimit
  scopePaths: readonly string[]
}): AiVaultListResult | null {
  // Why no unbounded fallback here: an unlimited answer keys WITHOUT a scope, so an unlimited
  // request finds it as its own entry, and a scoped one is refused by the depth rule below — the
  // scan caches own the "an unbounded scan answers a bounded request" rule, not this one.
  const cached = cachedSessionResults.get(args.key)
  if (!cached || !aiVaultCachedDepthServes(cached.limit, args.limit, args.scopePaths)) {
    return null
  }
  cachedSessionResults.delete(args.key)
  cachedSessionResults.set(args.key, cached)
  return truncateAiVaultListResult(cached.result, args.limit, args.scopePaths)
}

export function cacheAiVaultSessionResult(args: {
  key: string
  executionHostScope: ExecutionHostScope
  limit: AiVaultSessionLimit
  scopePaths: readonly string[]
  result: AiVaultListResult
  replaceHostEntries: boolean
}): void {
  if (args.replaceHostEntries) {
    for (const [key, cached] of cachedSessionResults) {
      if (cached.executionHostScope === args.executionHostScope) {
        cachedSessionResults.delete(key)
      }
    }
  }
  cachedSessionResults.delete(args.key)
  cachedSessionResults.set(args.key, {
    executionHostScope: args.executionHostScope,
    limit: args.limit,
    result: args.result
  })
  while (cachedSessionResults.size > MAX_CACHED_SESSION_SCOPES) {
    const oldestKey = cachedSessionResults.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    cachedSessionResults.delete(oldestKey)
  }
}

export function resetAiVaultSessionResultCacheForTest(): void {
  cachedSessionResults.clear()
}

export function invalidateAiVaultSessionResults(host: ExecutionHostScope): void {
  for (const [key, entry] of cachedSessionResults) {
    if (entry.executionHostScope === host || entry.executionHostScope === 'all') {
      cachedSessionResults.delete(key)
    }
  }
}
