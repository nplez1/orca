import type {
  AiVaultListResult,
  AiVaultListSyncDelta,
  AiVaultScanIssue,
  AiVaultSession
} from '../../shared/ai-vault-types'
import { applyAiVaultListDelta } from '../../shared/ai-vault-list-sync'
import { AI_VAULT_LIST_SKIP_ISSUE_PATH } from '../../shared/ai-vault-types'
import type { AiVaultSessionDepth } from '../../shared/ai-vault-session-depth'

/**
 * A host leg's change sync, as a wrapper around the scan the host-leg cache calls.
 *
 * Why a wrapper and not part of the cache: the cache is upstream's, and its `scan` takes no
 * arguments. Wrapping it at the call site keeps that signature, and keeps these held lists out of
 * the cache's own, which upstream clears on every delete.
 */

/** What this host's held list was, so a refresh can ask for the difference from it. */
export type AiVaultHostLegSyncBasis = {
  fingerprint: string
  sessions: readonly AiVaultSession[]
}

type HeldList = { depth: AiVaultSessionDepth; result: AiVaultListResult }

/**
 * Rows held lists may total, ~1.5 KB each from the scanner, so main keeps tens of megabytes
 * rather than one 15 MB history per scope and host. A count cap alone would not bound that: every
 * paged reply carries a fingerprint, including an unlimited listing.
 *
 * The trade-off is deliberate: a host whose own listing approaches this bound can be evicted by
 * another host's store and then pays a full read on its next refresh, which is cheaper than
 * holding every scope's history for the life of the process.
 */
export const LAST_FULL_HOST_LEG_MAX_ROWS = 40_000
const HELD_LISTS_MAX = 8

/**
 * Keyed by the leg's scope identity rather than the request's cache key, so the all-hosts view can
 * sync from the list the single-host view already loaded. Why they survive a delete: a diff is
 * computed against a content-addressed fingerprint, so it describes whatever the host's list now
 * is — a deleted row comes back in `removedIds`. Clearing them would make the forced refresh that
 * follows a delete re-download each remote host's whole history.
 */
const heldLists = new Map<string, HeldList>()

/**
 * The scan to hand the host-leg cache: it sends the held list's fingerprint, applies the delta
 * the host answers with, and holds the full list it returns as the next refresh's basis.
 */
export function hostLegSyncScan(args: {
  /** Identity of the listing this leg holds, independent of which view asked for it. */
  syncBasisKey: string
  depth: AiVaultSessionDepth
  /** The host this leg addresses; names it in an issue row this module has to author itself. */
  hostLabel: string
  /** Receives the basis to sync from, or undefined when this leg holds no full list yet. */
  scan: (syncFrom: AiVaultHostLegSyncBasis | undefined) => Promise<AiVaultListResult>
}): () => Promise<AiVaultListResult> {
  return async () => {
    // Why capture rather than look up afterwards: the basis is what the delta is applied to, and a
    // concurrent scan must not swap it out between the request and the reply.
    const basis = hostLegSyncBasis(args.syncBasisKey, args.depth)
    const scanned = await scanWithSyncBasis(args, basis)
    const delta = scanned.syncDelta
    const result = delta && basis ? withAppliedDelta(basis, delta, scanned) : scanned
    return holdFullList(args.syncBasisKey, args.depth, result)
  }
}

/**
 * A delta is only meaningful against the list this leg sent, so a host that answers one without a
 * basis gets one retry without a token. Why not throw: under the 'all' scope a throw here would
 * reject the merged Promise.all and take every other host's list down with it.
 */
async function scanWithSyncBasis(
  args: Parameters<typeof hostLegSyncScan>[0],
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
  syncBasisKey: string,
  depth: AiVaultSessionDepth
): AiVaultHostLegSyncBasis | undefined {
  const held = heldLists.get(syncBasisKey)
  const fingerprint = held?.result.fingerprint
  if (held?.depth !== depth || !fingerprint) {
    return undefined
  }
  // Why refuse a body that reported skips: a diff never re-sends the rows it did not change, so the
  // notice could never be withdrawn once the row was fixed, and a full read derives it again from
  // the rows in front of it — the only way it stays true. The cost is that a host serving a row this
  // build cannot read is fully read on every refresh until the build can; that is bounded, visible,
  // and cheaper than a warning that outlives its cause.
  if (held.result.issues.some(isClientSkipIssue)) {
    return undefined
  }
  return { fingerprint, sessions: held.result.sessions }
}

function withAppliedDelta(
  basis: AiVaultHostLegSyncBasis,
  delta: AiVaultListSyncDelta,
  reply: AiVaultListResult
): AiVaultListResult {
  return {
    sessions: applyAiVaultListDelta(basis.sessions, delta),
    issues: reply.issues,
    scannedAt: reply.scannedAt,
    ...(reply.fingerprint ? { fingerprint: reply.fingerprint } : {})
  }
}

/**
 * Holds a healthy full list as the next refresh's basis. An `unchanged` reply passes through
 * as-is: it is what a caller that sent its own fingerprint asked for, and the cache expands it.
 */
function holdFullList(
  syncBasisKey: string,
  depth: AiVaultSessionDepth,
  result: AiVaultListResult
): AiVaultListResult {
  if (
    !result.fingerprint ||
    result.unchanged ||
    result.issues.some((issue) => issue.kind === 'host')
  ) {
    return result
  }
  heldLists.delete(syncBasisKey)
  heldLists.set(syncBasisKey, { depth, result })
  pruneHeldListsByRows(heldLists, HELD_LISTS_MAX)
  return result
}

/** The row this client writes when it had to skip result entries it cannot read. */
function isClientSkipIssue(issue: AiVaultScanIssue): boolean {
  return issue.path === AI_VAULT_LIST_SKIP_ISSUE_PATH
}

/**
 * Oldest first, and never the one just stored — it is the basis the next refresh diffs against.
 * Exported for the host-leg cache's own held lists, which every fingerprinted reply also fills.
 */
export function pruneHeldListsByRows(
  lists: Map<string, { result: AiVaultListResult }>,
  maxEntries: number
): void {
  let rows = 0
  for (const entry of lists.values()) {
    rows += entry.result.sessions.length
  }
  for (const [key, entry] of lists) {
    if (lists.size === 1) {
      break
    }
    if (lists.size <= maxEntries && rows <= LAST_FULL_HOST_LEG_MAX_ROWS) {
      break
    }
    lists.delete(key)
    rows -= entry.result.sessions.length
  }
}

export function resetAiVaultHostLegSyncForTests(): void {
  heldLists.clear()
}
