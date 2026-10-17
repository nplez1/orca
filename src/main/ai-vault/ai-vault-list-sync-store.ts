import type {
  AiVaultListSyncDelta,
  AiVaultScanIssue,
  AiVaultSession
} from '../../shared/ai-vault-types'
import type { AiVaultListSnapshot } from './session-list-fingerprint'
import { AI_VAULT_LIST_PAGE_CONTENT_BUDGET_BYTES } from './session-list-page-bounds'

/**
 * Digests a host keeps for the listings it has served, so the next refresh can answer with only
 * what changed. Bounded, with one deliberate exception: the newest entry is always kept even when
 * it alone exceeds the budget, because evicting it would make the listing just served the one list
 * that can never sync. A token whose entry was evicted falls back to a full listing.
 */
export const AI_VAULT_LIST_SYNC_RETAINED_BYTES = 16 * 1024 * 1024

/**
 * Map slot, two string headers and the key's own copy, so the bound covers what V8 actually
 * retains rather than just the id and digest payload.
 */
const ENTRY_OVERHEAD_BYTES = 128

type RetainedSnapshot = {
  digests: ReadonlyMap<string, string>
  bytes: number
}

// Insertion order is the LRU order: re-retaining a fingerprint refreshes its place.
const retained = new Map<string, RetainedSnapshot>()
let retainedBytes = 0

function snapshotBytes(digests: ReadonlyMap<string, string>): number {
  let bytes = 0
  for (const [id, digest] of digests) {
    // Why bytes: a transcript path may hold non-ASCII, and `length` undercounts it by up to 3x.
    bytes += Buffer.byteLength(id, 'utf8') + digest.length + ENTRY_OVERHEAD_BYTES
  }
  return bytes
}

export function retainAiVaultListSnapshot(snapshot: AiVaultListSnapshot): void {
  const bytes = snapshotBytes(snapshot.digests)
  const previous = retained.get(snapshot.fingerprint)
  if (previous) {
    retainedBytes -= previous.bytes
    retained.delete(snapshot.fingerprint)
  }
  retained.set(snapshot.fingerprint, { digests: snapshot.digests, bytes })
  retainedBytes += bytes
  // Why keep the newest entry regardless: evicting it would make its own fingerprint unsyncable.
  for (const [fingerprint, entry] of retained) {
    if (retainedBytes <= AI_VAULT_LIST_SYNC_RETAINED_BYTES || retained.size === 1) {
      break
    }
    retained.delete(fingerprint)
    retainedBytes -= entry.bytes
  }
}

export function retainedAiVaultListDigests(
  fingerprint: string
): ReadonlyMap<string, string> | null {
  const entry = retained.get(fingerprint)
  if (!entry) {
    return null
  }
  retained.delete(fingerprint)
  retained.set(fingerprint, entry)
  return entry.digests
}

/**
 * What a client holding `previous` is missing. Null when the delta would not fit one reply: a
 * first sync after a long gap is cheaper (and no larger) as a byte-bounded full page.
 */
export function aiVaultListSyncDelta(args: {
  previous: ReadonlyMap<string, string>
  current: AiVaultListSnapshot
  sessions: readonly AiVaultSession[]
  issues: readonly AiVaultScanIssue[]
}): AiVaultListSyncDelta | null {
  // Why measured row by row: a sync from a very old basis can name the whole listing, and
  // serialising it just to discover it is too large is exactly the work this bound avoids.
  let bytes = Buffer.byteLength(JSON.stringify(args.issues), 'utf8')
  const upserts: AiVaultSession[] = []
  for (const session of args.sessions) {
    if (args.previous.get(session.id) === args.current.digests.get(session.id)) {
      continue
    }
    bytes += Buffer.byteLength(JSON.stringify(session), 'utf8') + 1
    if (bytes > AI_VAULT_LIST_PAGE_CONTENT_BUDGET_BYTES) {
      return null
    }
    upserts.push(session)
  }
  const removedIds: string[] = []
  for (const id of args.previous.keys()) {
    if (args.current.digests.has(id)) {
      continue
    }
    bytes += Buffer.byteLength(JSON.stringify(id), 'utf8') + 1
    if (bytes > AI_VAULT_LIST_PAGE_CONTENT_BUDGET_BYTES) {
      return null
    }
    removedIds.push(id)
  }
  return { upserts, removedIds }
}

export function resetAiVaultListSyncStoreForTests(): void {
  retained.clear()
  retainedBytes = 0
}
