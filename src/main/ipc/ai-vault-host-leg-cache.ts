import { MAX_TIMER_DELAY_MS } from '../../shared/timer-delay'
import type {
  AiVaultListResult,
  AiVaultListSyncDelta,
  AiVaultSession
} from '../../shared/ai-vault-types'
import { applyAiVaultListDelta } from '../../shared/ai-vault-list-sync'
import {
  aiVaultSessionDepthCovers,
  truncateAiVaultListResult,
  type AiVaultSessionDepth
} from '../../shared/ai-vault-session-depth'

export const AI_VAULT_CACHE_TTL_MS = 15_000

type CachedHostLeg = {
  depth: AiVaultSessionDepth
  result: AiVaultListResult
  expiresAt: number
}

// Why: the merged result is only cacheable when every host answered, so one
// flaky host used to force a full rescan of every healthy host on each panel
// open. Legs are cached individually and the failing host is the only one
// rescanned.
const cachedHostLegs = new Map<string, CachedHostLeg>()
// Bumped on every invalidation. A leg scan that started before an invalidation
// carries the old generation and must not write its (now stale) result back —
// otherwise a delete's invalidation is silently undone by a scan that resolves
// just after it.
let cacheGeneration = 0
// Why: an `unchanged` reply carries no rows, so without the last full list the
// TTL cache could only hold the empty marker and fingerprint-less readers (tab
// session lookup, other windows) would pay a full remote scan.
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

/** What this host's held list was, so a refresh can ask for the difference from it. */
export type AiVaultHostLegSyncBasis = {
  fingerprint: string
  sessions: readonly AiVaultSession[]
}

/** Serves one host's leg from the per-host TTL cache, and stores it only when
 * that host answered without a host issue — a failing host is retried on the
 * next open while its healthy neighbours stay cached. */
export async function scanHostLegWithCache(args: {
  cacheKey: string
  depth: AiVaultSessionDepth
  scopePaths?: readonly string[]
  force: boolean
  afterFingerprint?: string | null
  /** The host this leg addresses; names it in an issue row this module has to author itself. */
  hostLabel: string
  /**
   * Identity of the listing this leg holds, independent of which view asked for it: the all-hosts
   * view must be able to sync from the list the single-host view already loaded, or a large
   * history could never finish loading within its own drain budget.
   */
  syncBasisKey: string
  /** Receives the basis to sync from, or undefined when this leg holds no full list yet. */
  scan: (syncFrom: AiVaultHostLegSyncBasis | undefined) => Promise<AiVaultListResult>
}): Promise<AiVaultListResult> {
  const now = Date.now()
  const startGeneration = cacheGeneration
  const cached = cachedHostLegs.get(args.cacheKey)
  if (
    !args.force &&
    cached &&
    cached.expiresAt > now &&
    aiVaultSessionDepthCovers(cached.depth, args.depth) &&
    (!cached.result.unchanged ||
      (cached.depth === args.depth && cached.result.fingerprint === args.afterFingerprint))
  ) {
    return truncateAiVaultListResult(cached.result, args.depth, args.scopePaths)
  }
  // Why capture rather than look up afterwards: the basis is what the delta is applied to, and a
  // concurrent scan must not swap it out between the request and the reply.
  const basis = hostLegSyncBasis(args.syncBasisKey, args.depth)
  const scanned = await scanWithSyncBasis(args, basis)
  const delta = scanned.syncDelta
  const result = delta && basis ? withAppliedDelta(basis.sessions, delta, scanned) : scanned
  // A delete's invalidation landed while this leg was scanning; caching a
  // pre-delete result would resurrect the deleted session for the TTL.
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
    aiVaultSessionDepthCovers(current.depth, args.depth) &&
    (!current.result.unchanged ||
      (current.depth === args.depth && current.result.fingerprint === args.afterFingerprint))
  ) {
    return result
  }
  cachedHostLegs.set(args.cacheKey, {
    depth: args.depth,
    result: rememberFullHostLeg(args.syncBasisKey, args.depth, result),
    expiresAt: Date.now() + AI_VAULT_CACHE_TTL_MS
  })
  scheduleHostLegExpiry()
  return result
}

/**
 * A delta is only meaningful against the list this leg sent, so a host that answers one without a
 * basis gets one retry without a token. Why not throw: under the 'all' scope a throw here would
 * reject the merged Promise.all and take every other host's list down with it.
 */
async function scanWithSyncBasis(
  args: Parameters<typeof scanHostLegWithCache>[0],
  basis: AiVaultHostLegSyncBasis | undefined
): Promise<AiVaultListResult> {
  const first = await args.scan(basis)
  if (!first.syncDelta || basis) {
    return first
  }
  const retried = await args.scan(undefined)
  if (!retried.syncDelta) {
    return retried
  }
  // Both attempts named a list this leg never sent; say so instead of caching an empty body.
  return {
    sessions: [],
    issues: [
      ...retried.issues,
      {
        agent: 'codex',
        kind: 'host',
        path: args.hostLabel,
        message: 'The session host answered with changes this computer does not hold.'
      }
    ],
    scannedAt: retried.scannedAt
  }
}

/** The full list this leg holds at exactly this depth; a shallower depth cannot reuse it. */
function hostLegSyncBasis(
  cacheKey: string,
  depth: AiVaultSessionDepth
): AiVaultHostLegSyncBasis | undefined {
  const held = lastFullHostLegs.get(cacheKey)
  const fingerprint = held?.result.fingerprint
  return held?.depth === depth && fingerprint
    ? { fingerprint, sessions: held.result.sessions }
    : undefined
}

function withAppliedDelta(
  held: readonly AiVaultSession[],
  delta: AiVaultListSyncDelta,
  reply: AiVaultListResult
): AiVaultListResult {
  return {
    sessions: applyAiVaultListDelta(held, delta),
    issues: reply.issues,
    scannedAt: reply.scannedAt,
    ...(reply.fingerprint ? { fingerprint: reply.fingerprint } : {})
  }
}

/** Returns the full list an `unchanged` reply stands for when one is known. */
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
  for (const oldest of lastFullHostLegs.keys()) {
    if (lastFullHostLegs.size <= LAST_FULL_HOST_LEGS_MAX) {
      break
    }
    lastFullHostLegs.delete(oldest)
  }
  return result
}

function pruneExpiredHostLegs(now: number): void {
  for (const [cacheKey, entry] of cachedHostLegs) {
    if (entry.expiresAt <= now) {
      cachedHostLegs.delete(cacheKey)
    }
  }
}

// Drops every cached host leg after a session is deleted so a non-force list
// call within the TTL can't still serve the trashed session. Scan discovery
// walks disk first, so a deleted file is never rediscovered — this only guards
// the cached RESULT.
export function invalidateAiVaultHostLegCache(): void {
  cacheGeneration++
  cachedHostLegs.clear()
  // Why the held lists survive: they are the basis every refresh diffs against, and a delete only
  // ever trashes a local (or WSL) transcript, so a remote host's list cannot contain the deleted
  // row. Clearing them would make the forced refresh that follows a delete re-download each remote
  // host's whole history for nothing.
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer)
  }
  expiryTimer = null
}

export function resetAiVaultHostLegCacheForTests(): void {
  invalidateAiVaultHostLegCache()
  lastFullHostLegs.clear()
}
