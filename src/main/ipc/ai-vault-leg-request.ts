import type { AiVaultListArgs } from '../../shared/ai-vault-types'
import { aiVaultAppliedScopePaths } from '../../shared/ai-vault-session-depth'
import type { AiVaultHostLegSyncBasis } from './ai-vault-host-leg-cache'

/**
 * What one host's listing for this scope is called, whichever view asked for it. Why not the
 * request cache key: that key carries the host *scope* ('all' vs one host), and the all-hosts view
 * must be able to sync from the list the single-host view already loaded.
 */
export function aiVaultLegScopeKey(args: AiVaultListArgs | undefined, hostId: string): string {
  return JSON.stringify({
    // Why the applied paths: under no bound the answer holds every scope, so keying on the scope
    // would split one basis into one per project — and switching project would re-download it.
    scopePaths: [...new Set(aiVaultAppliedScopePaths(args) ?? [])].sort(),
    includeAntigravityIdeSessions: args?.includeAntigravityIdeSessions === true,
    hostId
  })
}

/**
 * One leg's request. Why both fields are per leg: the merged 'all' result has no single
 * fingerprint, so a leg never answers the merge's "is it unchanged" question, and the token it
 * sends is always its own held list rather than whatever the caller passed.
 */
export function legListArgs(
  args: AiVaultListArgs | undefined,
  syncFrom: AiVaultHostLegSyncBasis | undefined
): AiVaultListArgs | undefined {
  return args
    ? { ...args, afterFingerprint: undefined, syncFromFingerprint: syncFrom?.fingerprint }
    : undefined
}
