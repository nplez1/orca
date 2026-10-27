import { MAX_TIMER_DELAY_MS } from '../../shared/timer-delay'
import type { AiVaultListResult } from '../../shared/ai-vault-types'
import {
  aiVaultCachedDepthServes,
  truncateAiVaultListResult,
  type AiVaultSessionDepth
} from '../../shared/ai-vault-session-depth'
import { pruneHeldListsByRows } from './ai-vault-host-leg-sync'

export const AI_VAULT_CACHE_TTL_MS = 15_000

type CachedHostLeg = {
  depth: AiVaultSessionDepth
  result: AiVaultListResult
  expiresAt: number
}

// Cache healthy legs independently so one failing host cannot force every host to rescan.
const cachedHostLegs = new Map<string, CachedHostLeg>()
// Fence scans begun before invalidation so late results cannot resurrect deleted sessions.
let cacheGeneration = 0
// Retain rows behind unchanged replies for readers without fingerprints.
const lastFullHostLegs = new Map<
  string,
  { depth: AiVaultSessionDepth; result: AiVaultListResult }
>()
const LAST_FULL_HOST_LEGS_MAX = 8
let expiryTimer: ReturnType<typeof setTimeout> | null = null

function scheduleHostLegExpiry(): void {
  if (expiryTimer !== null || cachedHostLegs.size === 0) {
    return
  }
  let earliest = Infinity
  for (const entry of cachedHostLegs.values()) {
    earliest = Math.min(earliest, entry.expiresAt)
  }
  expiryTimer = setTimeout(
    () => {
      expiryTimer = null
      pruneExpiredHostLegs(Date.now())
      scheduleHostLegExpiry()
    },
    Math.min(MAX_TIMER_DELAY_MS, Math.max(0, earliest - Date.now()))
  )
  expiryTimer.unref?.()
}

/** Cache only healthy legs so failing hosts retry without rescanning their neighbors. */
export async function scanHostLegWithCache(args: {
  cacheKey: string
  /** The key an unbounded leg is stored under: it answers every scope at every depth. */
  unboundedCacheKey?: string
  depth: AiVaultSessionDepth
  scopePaths?: readonly string[]
  force: boolean
  afterFingerprint?: string | null
  scan: () => Promise<AiVaultListResult>
}): Promise<AiVaultListResult> {
  const now = Date.now()
  const startGeneration = cacheGeneration
  const own = cachedHostLegs.get(args.cacheKey)
  const unbounded =
    own === undefined && args.unboundedCacheKey !== undefined
      ? cachedHostLegs.get(args.unboundedCacheKey)
      : undefined
  const cached = own ?? (unbounded?.depth === 'unlimited' ? unbounded : undefined)
  if (
    !args.force &&
    cached &&
    cached.expiresAt > now &&
    // Why the unbounded bypass: an unbounded leg is stored without a scope and holds every
    // scope's rows, so it answers a scoped request the same way its own unbounded read did.
    (cached.depth === 'unlimited' ||
      aiVaultCachedDepthServes(cached.depth, args.depth, args.scopePaths)) &&
    (!cached.result.unchanged ||
      (cached.depth === args.depth && cached.result.fingerprint === args.afterFingerprint))
  ) {
    return truncateAiVaultListResult(cached.result, args.depth, args.scopePaths)
  }
  const result = await args.scan()
  // A pre-delete scan must not repopulate the invalidated cache.
  if (startGeneration !== cacheGeneration) {
    return result
  }
  if (result.issues.some((issue) => issue.kind === 'host')) {
    const current = cachedHostLegs.get(args.cacheKey)
    if (!current || current.expiresAt <= Date.now()) {
      cachedHostLegs.delete(args.cacheKey)
    }
    return result
  }
  pruneExpiredHostLegs(now)
  const current = cachedHostLegs.get(args.cacheKey)
  if (
    !args.force &&
    current &&
    current.expiresAt > Date.now() &&
    (current.depth === 'unlimited' ||
      aiVaultCachedDepthServes(current.depth, args.depth, args.scopePaths)) &&
    (!current.result.unchanged ||
      (current.depth === args.depth && current.result.fingerprint === args.afterFingerprint))
  ) {
    return result
  }
  cachedHostLegs.set(args.cacheKey, {
    depth: args.depth,
    result: rememberFullHostLeg(args.cacheKey, args.depth, result),
    expiresAt: Date.now() + AI_VAULT_CACHE_TTL_MS
  })
  scheduleHostLegExpiry()
  return result
}

function rememberFullHostLeg(
  cacheKey: string,
  depth: AiVaultSessionDepth,
  result: AiVaultListResult
): AiVaultListResult {
  if (!result.fingerprint) {
    return result
  }
  const previous = lastFullHostLegs.get(cacheKey)
  if (result.unchanged) {
    return previous?.depth === depth && previous.result.fingerprint === result.fingerprint
      ? { ...previous.result, scannedAt: result.scannedAt }
      : result
  }
  lastFullHostLegs.delete(cacheKey)
  lastFullHostLegs.set(cacheKey, { depth, result })
  pruneHeldListsByRows(lastFullHostLegs, LAST_FULL_HOST_LEGS_MAX)
  return result
}

function pruneExpiredHostLegs(now: number): void {
  for (const [cacheKey, entry] of cachedHostLegs) {
    if (entry.expiresAt <= now) {
      cachedHostLegs.delete(cacheKey)
    }
  }
}

// Drop cached results after deletion; disk discovery already excludes the deleted file.
export function invalidateAiVaultHostLegCache(): void {
  cacheGeneration++
  cachedHostLegs.clear()
  lastFullHostLegs.clear()
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer)
  }
  expiryTimer = null
}

export function resetAiVaultHostLegCacheForTests(): void {
  invalidateAiVaultHostLegCache()
}
