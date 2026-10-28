import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../shared/remote-runtime/remote-runtime-memory-limits'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'

/**
 * Half of one wire frame, the same ratio the session-history page uses. A listing is bounded by
 * bytes rather than rows because a row is bounded only by what its transcript held: thousands of
 * 1.5 KB rows are a 15 MB reply the encrypted channel refuses outright (1013), and refusing one
 * reply drops every other RPC on that socket.
 */
export const AI_VAULT_LIST_MAX_PAGE_BYTES = REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES / 2

/** Envelope, request id, cursor and fingerprint headroom; the other half of the frame is slack. */
const PAGE_ENVELOPE_RESERVE_BYTES = 64 * 1024

export const AI_VAULT_LIST_PAGE_CONTENT_BUDGET_BYTES =
  AI_VAULT_LIST_MAX_PAGE_BYTES - PAGE_ENVELOPE_RESERVE_BYTES

/** A row is measured in the exact form it is sent, so escaping needs no expansion factor. */
function sessionRowBytes(session: AiVaultSession): number {
  // +1 for the array separator every row but the first adds.
  return Buffer.byteLength(JSON.stringify(session), 'utf8') + 1
}

/**
 * One byte-bounded page of an already-sorted listing. Rows are contiguous, so the client's
 * concatenation keeps the host's order, and `nextOffset` is a plain row index.
 */
export function pageAiVaultListResult(
  result: AiVaultListResult,
  offset: number,
  maxBytes = AI_VAULT_LIST_PAGE_CONTENT_BUDGET_BYTES
): AiVaultListResult {
  const start = Math.min(Math.max(Math.floor(offset), 0), result.sessions.length)
  // Issues and the fingerprint describe the whole scan, so only page 0 carries them.
  const onFirstPage = start === 0
  const issuesBytes = onFirstPage ? Buffer.byteLength(JSON.stringify(result.issues), 'utf8') + 1 : 0
  const rowBudget = Math.max(0, maxBytes - issuesBytes)
  const page: AiVaultSession[] = []
  let bytes = 0
  for (let index = start; index < result.sessions.length; index += 1) {
    const session = result.sessions[index]!
    const rowBytes = sessionRowBytes(session)
    // Why: an empty page would stall the drain, so one row is always returned even when it alone
    // exceeds the budget — the envelope reserve is what covers that overshoot.
    if (page.length > 0 && bytes + rowBytes > rowBudget) {
      break
    }
    page.push(session)
    bytes += rowBytes
  }
  const nextOffset = start + page.length
  const hasMore = nextOffset < result.sessions.length
  return {
    sessions: page,
    issues: onFirstPage ? result.issues : [],
    scannedAt: result.scannedAt,
    ...(onFirstPage && result.fingerprint ? { fingerprint: result.fingerprint } : {}),
    ...(hasMore ? { hasMore: true as const, nextOffset } : {})
  }
}
