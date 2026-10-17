import type { AiVaultListResult, AiVaultListSyncDelta } from '../../shared/ai-vault-types'
import {
  retainAiVaultListSnapshot,
  retainedAiVaultListDigests,
  aiVaultListSyncDelta
} from './ai-vault-list-sync-store'
import { aiVaultListSnapshot, type AiVaultListSnapshot } from './session-list-fingerprint'
import { pageAiVaultListResult } from './session-list-page-bounds'

/**
 * A paging client's reply: either the changed rows only, or a byte-bounded page of the listing.
 *
 * Retaining this listing's digests under its own fingerprint is what makes the *next* refresh a
 * delta — a 15 MB history is digested once per scan, then answered with the handful of rows that
 * actually changed.
 */
export function aiVaultPagedListReply(args: {
  result: AiVaultListResult
  offset: number
  force: boolean
  /** Identity of the scan being sliced; see `aiVaultListToken`. */
  listToken: string
  afterFingerprint?: string | null
  syncFromFingerprint?: string
}): AiVaultListResult {
  const listToken = args.listToken
  if (args.offset > 0) {
    // A later page is a different body: it answers no fingerprint question, and the client keeps
    // the fingerprint page 0 carried.
    return { ...pageAiVaultListResult(args.result, args.offset), listToken }
  }
  const snapshot = aiVaultListSnapshot(args.result)
  retainAiVaultListSnapshot(snapshot)
  if (!args.force && args.afterFingerprint === snapshot.fingerprint) {
    return {
      sessions: [],
      issues: [],
      scannedAt: args.result.scannedAt,
      fingerprint: snapshot.fingerprint,
      unchanged: true
    }
  }
  // Why force refuses the delta too: a forced refresh is the user's "show me the real list", and a
  // delta can only be applied to whatever this client holds — the held list is what they may be
  // asking to get past.
  const delta = args.force ? null : deltaFrom(args.syncFromFingerprint, snapshot, args.result)
  if (delta) {
    // Why not `unchanged` for a matching token: an unchanged reply means "keep the body you have",
    // and a caller that asked for a full body (a retry after a mismatch) has to receive rows.
    return {
      sessions: [],
      issues: args.result.issues,
      scannedAt: args.result.scannedAt,
      fingerprint: snapshot.fingerprint,
      syncDelta: delta
    }
  }
  const page = pageAiVaultListResult(args.result, args.offset)
  return { ...page, fingerprint: snapshot.fingerprint, listToken }
}

/**
 * The scan a page was sliced from. Its rows and their order are fixed by that scan, so two pages
 * sharing this token are slices of one list and a different token means the listing moved.
 *
 * Why the scan id: a rescan is what changes the rows behind an offset, and the scanner mints a new
 * id for every scan it runs. The timestamp and count are the fallback for a result that carries
 * none (a caller that did not go through the shared scan cache).
 */
export function aiVaultListToken(result: AiVaultListResult): string {
  return result.scanId ?? `${result.scannedAt}\u0000${result.sessions.length}`
}

function deltaFrom(
  fingerprint: string | undefined,
  snapshot: AiVaultListSnapshot,
  result: AiVaultListResult
): AiVaultListSyncDelta | null {
  if (fingerprint === undefined) {
    return null
  }
  const previous = retainedAiVaultListDigests(fingerprint)
  return previous === null
    ? null
    : aiVaultListSyncDelta({
        previous,
        current: snapshot,
        sessions: result.sessions,
        issues: result.issues
      })
}
