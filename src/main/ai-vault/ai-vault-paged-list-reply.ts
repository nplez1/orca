import { createHash } from 'node:crypto'
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
  const listToken = aiVaultListToken(args.result)
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
 * The listed rows in their order, as one identity. Ids are unique within a listing, so the sequence
 * names exactly which rows a page offsets into — which is what a page request needs, and nothing
 * more.
 *
 * Why not the scan id: what a page is sliced from is the *served* list, and serving filters rows per
 * request (structured-chat ownership is read live), so one scan can back two different served
 * lists. Why ids and not the row digests: an unchanged rescan must keep the same token or a drain
 * slower than the host's scan cache could never finish, and hashing ids is cheap enough to repeat on
 * every page.
 */
export function aiVaultListToken(result: AiVaultListResult): string {
  const hash = createHash('sha256')
  for (const session of result.sessions) {
    hash.update(session.id).update('\n')
  }
  return hash.digest('hex')
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
