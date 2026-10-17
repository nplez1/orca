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
  afterFingerprint?: string | null
  syncFromFingerprint?: string
}): AiVaultListResult {
  if (args.offset > 0) {
    // A later page is a different body: it answers no fingerprint question, and the client keeps
    // the fingerprint page 0 carried.
    return pageAiVaultListResult(args.result, args.offset)
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
  // Why still a delta under force: force asks for a fresh scan, which already happened, so the new
  // digests are what the caller should receive. Only `unchanged` is refused, so a forced refresh
  // always carries a body.
  const delta = deltaFrom(args.syncFromFingerprint, snapshot, args.result)
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
  return { ...page, fingerprint: snapshot.fingerprint }
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
    : aiVaultListSyncDelta({ previous, current: snapshot, sessions: result.sessions })
}
