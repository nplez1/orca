import type { RuntimeStatus } from '../../../shared/runtime-types'

const RUNTIME_COMPATIBILITY_CACHE_MAX = 32
const RECENT_RUNTIME_COMPATIBILITY_FAILURE_TTL_MS = 60_000
// Why: capability verdicts must eventually follow a saved environment's version changes.
export const RUNTIME_CAPABILITY_STATUS_TTL_MS = 60_000

export type RuntimeCompatibilityCacheEntry = {
  check: Promise<void>
  failedAt: number | null
  // False while probing so recovery can drop a doomed pending compatibility check.
  provenCompatible: boolean
  status: RuntimeStatus | null
  statusCheckedAt: number | null
}

export const runtimeCompatibilityChecks = new Map<string, RuntimeCompatibilityCacheEntry>()
const workspacePathSearchCapabilityInvalidationListeners = new Set<
  (environmentId: string | null) => void
>()

export function getCachedRuntimeCompatibilityCheck(
  environmentId: string,
  options: { reuseRecentCompatibilityFailure?: boolean }
): RuntimeCompatibilityCacheEntry | null {
  const cached = runtimeCompatibilityChecks.get(environmentId)
  if (!cached) {
    return null
  }
  if (
    cached.failedAt !== null &&
    Date.now() - cached.failedAt >= RECENT_RUNTIME_COMPATIBILITY_FAILURE_TTL_MS
  ) {
    runtimeCompatibilityChecks.delete(environmentId)
    return null
  }
  if (cached.failedAt !== null && options.reuseRecentCompatibilityFailure !== true) {
    return null
  }
  runtimeCompatibilityChecks.delete(environmentId)
  runtimeCompatibilityChecks.set(environmentId, cached)
  return cached
}

export function rememberRuntimeEnvironmentCompatibility(
  environmentId: string,
  entry: RuntimeCompatibilityCacheEntry
): void {
  // Why: saved/removed remote runtimes can churn through unique ids in long
  // renderer sessions; compatibility cache entries should not grow forever.
  runtimeCompatibilityChecks.delete(environmentId)
  runtimeCompatibilityChecks.set(environmentId, entry)
  while (runtimeCompatibilityChecks.size > RUNTIME_COMPATIBILITY_CACHE_MAX) {
    const oldest = runtimeCompatibilityChecks.keys().next().value
    if (oldest === undefined) {
      break
    }
    runtimeCompatibilityChecks.delete(oldest)
  }
}

export function subscribeRuntimeWorkspacePathSearchCapabilityInvalidation(
  listener: (environmentId: string | null) => void
): () => void {
  workspacePathSearchCapabilityInvalidationListeners.add(listener)
  return () => workspacePathSearchCapabilityInvalidationListeners.delete(listener)
}

function notifyWorkspacePathSearchCapabilityInvalidation(environmentId: string | null): void {
  for (const listener of workspacePathSearchCapabilityInvalidationListeners) {
    listener(environmentId)
  }
}

export function invalidateWorkspacePathSearchCapabilitiesForReplacement(
  previous: RuntimeStatus | null,
  current: RuntimeStatus,
  environmentId: string
): void {
  if (previous && previous.runtimeId !== current.runtimeId) {
    notifyWorkspacePathSearchCapabilityInvalidation(environmentId)
  }
}

// Why: a live status answer invalidates failures and pending probes from the
// dropped connection; only proven-compatible successes remain reusable.
export function clearRecentRuntimeCompatibilityFailure(
  environmentId: string,
  observedStatus?: RuntimeStatus
): void {
  const trimmed = environmentId.trim()
  if (!trimmed) {
    return
  }
  const cached = runtimeCompatibilityChecks.get(trimmed)
  if (
    cached &&
    (!cached.provenCompatible ||
      (observedStatus &&
        cached.status !== null &&
        cached.status.runtimeId !== observedStatus.runtimeId))
  ) {
    // Why: a saved endpoint can reconnect to a different runtime version; its predecessor's
    // positive capability verdict must not route a structured request to the replacement.
    runtimeCompatibilityChecks.delete(trimmed)
    notifyWorkspacePathSearchCapabilityInvalidation(trimmed)
  }
}

export function clearRuntimeCompatibilityCache(environmentId?: string | null): void {
  const trimmed = environmentId?.trim()
  if (trimmed) {
    runtimeCompatibilityChecks.delete(trimmed)
    notifyWorkspacePathSearchCapabilityInvalidation(trimmed)
    return
  }
  runtimeCompatibilityChecks.clear()
  notifyWorkspacePathSearchCapabilityInvalidation(null)
}

export function markRuntimeEnvironmentCompatible(environmentId: string): void {
  const trimmed = environmentId.trim()
  if (!trimmed) {
    return
  }
  notifyWorkspacePathSearchCapabilityInvalidation(trimmed)
  rememberRuntimeEnvironmentCompatibility(trimmed, {
    check: Promise.resolve(),
    failedAt: null,
    provenCompatible: true,
    status: null,
    statusCheckedAt: null
  })
}

export function getCachedRuntimeEnvironmentStatus(environmentId: string): RuntimeStatus | null {
  const cached = runtimeCompatibilityChecks.get(environmentId.trim())
  return cached?.status ?? null
}

export function clearRuntimeCompatibilityCacheForTests(): void {
  clearRuntimeCompatibilityCache()
}
