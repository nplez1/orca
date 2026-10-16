import type { AiVaultListArgs } from './ai-vault-types'
import { requestedAiVaultSessionDepth } from './ai-vault-session-depth'
import { aiVaultHostListQuery } from './ai-vault-session-filters'

/** The local cache and coordinator entry for one scope and scan depth. */
export function aiVaultLocalScanKey(args?: AiVaultListArgs): string {
  return JSON.stringify({
    key: aiVaultLocalScanScopeKey(args),
    depth: requestedAiVaultSessionDepth(args)
  })
}

// The query is part of the scope, not a filter applied afterwards: the host
// answers a filtered request from a different result set, so a filtered listing
// must never be served for an unfiltered one (nor the reverse).
export function aiVaultLocalScanScopeKey(args?: AiVaultListArgs): string {
  return JSON.stringify({
    scopePaths: [...new Set(args?.scopePaths ?? [])].sort(),
    includeAntigravityIdeSessions: args?.includeAntigravityIdeSessions === true,
    query: aiVaultHostListQuery(args?.query ?? '')
  })
}
