import type { AiVaultListResult } from '../../../../shared/ai-vault-types'
import type { ExecutionHostScope } from '../../../../shared/execution-host'
import {
  aiVaultSessionDepthCovers,
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
  /** The key an unbounded request would have: its entry answers every scope. */
  unboundedKey?: string
  limit: AiVaultSessionLimit
  scopePaths: readonly string[]
}): AiVaultListResult | null {
  const own = cachedSessionResults.get(args.key)
  // An unbounded entry holds every scope at every depth, but it is stored without one.
  const unbounded =
    own === undefined && args.unboundedKey !== undefined
      ? cachedSessionResults.get(args.unboundedKey)
      : undefined
  const answersUnbounded = unbounded !== undefined && unbounded.limit === 'unlimited'
  const cached = own ?? (answersUnbounded ? unbounded : undefined)
  if (!cached || !aiVaultSessionDepthCovers(cached.limit, args.limit)) {
    return null
  }
  // Bump the entry that answered. Copying it onto this request's key would outrank the
  // fresher list that key is about to store.
  if (own === undefined && answersUnbounded && args.unboundedKey !== undefined) {
    cachedSessionResults.delete(args.unboundedKey)
    cachedSessionResults.set(args.unboundedKey, cached)
  } else {
    cachedSessionResults.delete(args.key)
    cachedSessionResults.set(args.key, cached)
  }
  return truncateAiVaultListResult(cached.result, args.limit, args.scopePaths)
}

export function cacheAiVaultSessionResult(args: {
  key: string
  executionHostScope: ExecutionHostScope
  limit: AiVaultSessionLimit
  result: AiVaultListResult
  replaceHostEntries: boolean
}): void {
  if (args.replaceHostEntries) {
    for (const [key, cached] of cachedSessionResults) {
      if (cached.executionHostScope === args.executionHostScope) {
        cachedSessionResults.delete(key)
      }
    }
  } else {
    const cached = cachedSessionResults.get(args.key)
    if (cached && aiVaultSessionDepthCovers(cached.limit, args.limit)) {
      return
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
