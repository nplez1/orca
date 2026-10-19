import { resetAiVaultSessionResultCacheForTest } from './ai-vault-session-result-cache'
import { resetAgentSessionIdsRefreshKeys } from './ai-vault-agent-session-refresh-key'

// In-app session creation bypasses the cache so the new session appears promptly.
// Keep the budget at module scope so tab remounts cannot amplify full scans.
const FORCED_RESCAN_MIN_INTERVAL_MS = 30_000
let lastForcedRescanAt = 0

/** Takes the shared forced-rescan budget when it is free. Every caller outside the panel that forces
 *  a scan must take it too, or it would amplify full scans the same way. A user's explicit request
 *  takes it even when spent, as the panel's Refresh does, so no automatic rescan follows it. */
export function claimAiVaultForcedRescan(userRequested = false): boolean {
  const now = Date.now()
  if (!userRequested && lastForcedRescanAt + FORCED_RESCAN_MIN_INTERVAL_MS > now) {
    return false
  }
  lastForcedRescanAt = now
  return true
}

/** A manual force scan counts against the budget, so an automatic rescan cannot follow it. */
export function markForcedRescanSpent(): void {
  lastForcedRescanAt = Date.now()
}

/** Why: the queued refresh waits out the budget rather than dropping the request. */
export function forcedRescanRetryDelayMs(): number {
  return Math.max(0, lastForcedRescanAt + FORCED_RESCAN_MIN_INTERVAL_MS - Date.now())
}

export function resetAiVaultForcedRescanThrottleForTest(): void {
  lastForcedRescanAt = 0
  resetAgentSessionIdsRefreshKeys()
  resetAiVaultSessionResultCacheForTest()
}
