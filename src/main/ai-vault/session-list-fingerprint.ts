import { createHash } from 'node:crypto'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'

/** 128 bits of a row's sha256: change detection between two scans, not a security boundary. */
const ROW_DIGEST_HEX_LENGTH = 32

export type AiVaultListSnapshot = {
  fingerprint: string
  /** Served row id -> row digest; what a later delta is computed against. */
  digests: ReadonlyMap<string, string>
}

function rowDigest(session: AiVaultSession): string {
  return createHash('sha256')
    .update(JSON.stringify(session))
    .digest('hex')
    .slice(0, ROW_DIGEST_HEX_LENGTH)
}

/** Everything a listing says besides its rows: issues, scan identity, cancellation. */
function listingMetadata(result: AiVaultListResult): string {
  return JSON.stringify({
    ...result,
    sessions: undefined,
    scannedAt: undefined,
    fingerprint: undefined,
    unchanged: undefined,
    hasMore: undefined,
    nextOffset: undefined,
    syncDelta: undefined
  })
}

/**
 * The fingerprint a client echoes back, plus the per-row digests a delta is computed from.
 *
 * Set-based on purpose: a row moving position is not a content change, because a synced client
 * derives its order from the rows it holds. Any change to the listing's own metadata (issues, the
 * scan identity) does change it, so an `unchanged` reply never hides a new banner.
 */
export function aiVaultListSnapshot(result: AiVaultListResult): AiVaultListSnapshot {
  const digests = new Map<string, string>()
  for (const session of result.sessions) {
    digests.set(session.id, rowDigest(session))
  }
  const hash = createHash('sha256').update(listingMetadata(result))
  for (const id of [...digests.keys()].sort()) {
    hash.update('\n').update(id).update('\0').update(digests.get(id)!)
  }
  return { fingerprint: hash.digest('hex'), digests }
}

export function conditionalAiVaultListResult(
  result: AiVaultListResult,
  afterFingerprint: string | null | undefined,
  force = false
): AiVaultListResult {
  if (afterFingerprint === undefined) {
    return result
  }
  const { fingerprint } = aiVaultListSnapshot(result)
  return !force && afterFingerprint === fingerprint
    ? { sessions: [], issues: [], scannedAt: result.scannedAt, fingerprint, unchanged: true }
    : { ...result, fingerprint }
}
