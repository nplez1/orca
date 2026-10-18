import { createAiVaultScopeCwdMatcher } from './ai-vault-scope-cwd-match'
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

// Scanners bound with slice/comparisons, so 'unlimited' resolves to no bound.
// Single owner of the normalization every scan limit goes through.
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
  args?: Pick<AiVaultListArgs, 'scopePaths' | 'unlimited'>
): readonly string[] | undefined {
  return args?.unlimited === true ? undefined : args?.scopePaths
}

export function truncateAiVaultListResult(
  result: AiVaultListResult,
  depth: AiVaultSessionDepth,
  scopePaths: readonly string[] = []
): AiVaultListResult {
  if (depth === 'unlimited') {
    return result
  }
  const selectedIds = new Set(result.sessions.slice(0, depth).map((session) => session.id))
  if (scopePaths.length > 0) {
    const inScope = createAiVaultScopeCwdMatcher(scopePaths)
    let scopedCount = 0
    for (const session of result.sessions) {
      if (inScope(session.cwd, session.filePath)) {
        selectedIds.add(session.id)
        if (++scopedCount >= depth) {
          break
        }
      }
    }
  }
  const sessions = result.sessions.filter((session) => selectedIds.has(session.id))
  return {
    ...result,
    sessions,
    ...(sessions.length !== result.sessions.length ? { fingerprint: undefined } : {})
  }
}
