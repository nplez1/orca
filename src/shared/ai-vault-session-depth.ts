import { aiVaultSessionInScope, createAiVaultScopeCwdMatcher } from './ai-vault-scope-cwd-match'
import type { AiVaultListArgs, AiVaultListResult } from './ai-vault-types'

export const DEFAULT_AI_VAULT_SCAN_LIMIT = 1000

export type AiVaultSessionDepth = number | 'unlimited'

export function requestedAiVaultSessionDepth(
  args?: Pick<AiVaultListArgs, 'limit' | 'unlimited'>
): AiVaultSessionDepth {
  if (args?.unlimited === true) {
    return 'unlimited'
  }
  return args?.limit && Number.isFinite(args.limit) && args.limit > 0
    ? Math.floor(args.limit)
    : DEFAULT_AI_VAULT_SCAN_LIMIT
}

// Normalize unlimited to no bound for scanner slices/comparisons; keep one owner for all scan limits.
export function aiVaultScanLimit(args?: Pick<AiVaultListArgs, 'limit' | 'unlimited'>): number {
  const depth = requestedAiVaultSessionDepth(args)
  return depth === 'unlimited' ? Number.POSITIVE_INFINITY : depth
}

export function aiVaultSessionDepthCovers(
  cached: AiVaultSessionDepth,
  requested: AiVaultSessionDepth
): boolean {
  return cached === 'unlimited' || (requested !== 'unlimited' && cached >= requested)
}

/**
 * The scope paths a list request's answer actually depends on.
 *
 * An unbounded read is the whole table, so a scope adds nothing to it. Anything that
 * keys such a request, or carries it to another host, must therefore leave the scope
 * out: keying on it repeats an identical read, and a host that still narrows on a
 * scope would answer 'All' with one project's sessions. Dropping it costs an older
 * host only the scope's guarantee past its own default cap.
 */
export function aiVaultAppliedScopePaths(
  args?: Pick<AiVaultListArgs, 'scopePaths' | 'unlimited'>,
  /** The host's scan spelling (a symlinked scope contributes its real path too). */
  resolvedScopePaths?: readonly string[]
): readonly string[] | undefined {
  if (args?.unlimited === true) {
    return undefined
  }
  return args?.scopePaths ? (resolvedScopePaths ?? args.scopePaths) : undefined
}

// A deeper scan keeps every scoped row it found, so a scoped request reuses only a scan of its
// own depth; a lowered depth otherwise shows the deeper scan's scoped rows again.
export function aiVaultCachedDepthServes(
  cached: AiVaultSessionDepth,
  requested: AiVaultSessionDepth,
  scopePaths: readonly string[] = []
): boolean {
  return scopePaths.length > 0 ? cached === requested : aiVaultSessionDepthCovers(cached, requested)
}

// Depth caps only out-of-scope rows; scoped sources have their own budgets. Preserve scan results so cache hits cannot display fewer rows.
export function truncateAiVaultListResult(
  result: AiVaultListResult,
  depth: AiVaultSessionDepth,
  scopePaths: readonly string[] = []
): AiVaultListResult {
  if (depth === 'unlimited') {
    return result
  }
  const inScope = scopePaths.length > 0 ? createAiVaultScopeCwdMatcher(scopePaths) : null
  let outOfScopeCount = 0
  const sessions = result.sessions.filter(
    (session) =>
      (inScope !== null && aiVaultSessionInScope(inScope, session)) || outOfScopeCount++ < depth
  )
  return {
    ...result,
    sessions,
    ...(sessions.length !== result.sessions.length ? { fingerprint: undefined } : {})
  }
}
