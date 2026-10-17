import type { AiVaultListArgs, AiVaultListResult, AiVaultScanIssue } from './ai-vault-types'
import type { ExecutionHostId } from './execution-host'
import { describeAiVaultScanError } from './ai-vault-scan-error-message'

/**
 * A remote reply carries at most 4 MiB, so a listing with thousands of rows never fits one frame.
 * A paging client asks the host for bounded pages and drains them here, which is why only a
 * client that understands `hasMore`/`nextOffset` may send `paged` at all: an older client gets
 * today's single reply rather than a silently truncated list.
 */

/** Progress guard, not a size policy: ~128 wire pages is far past any real history. */
export const AI_VAULT_LIST_MAX_PAGES = 128

export const AI_VAULT_LIST_TOO_MANY_PAGES_MESSAGE =
  'The session list was too large to load in one go. Refresh to try again.'

export type AiVaultListPageRead =
  | { kind: 'complete'; result: AiVaultListResult }
  /** Later pages arrived; this one failed. The rows already read are still worth showing. */
  | { kind: 'partial'; result: AiVaultListResult; error: unknown }
  /** The first page failed, so there is nothing to show. */
  | { kind: 'failed'; error: unknown }

/** The request for one page. Only the first page may carry the caller's fingerprints or force. */
export function aiVaultListPageArgs(base: AiVaultListArgs, offset: number): AiVaultListArgs {
  if (offset === 0) {
    return { ...base, paged: true, offset }
  }
  const {
    afterFingerprint: _fingerprint,
    force: _force,
    syncFromFingerprint: _sync,
    ...rest
  } = base
  return { ...rest, paged: true, offset }
}

/** The next offset a host offered, or null when this page ends the listing. */
export function aiVaultListNextOffset(result: AiVaultListResult, offset: number): number | null {
  if (result.hasMore !== true) {
    return null
  }
  const next = result.nextOffset
  return typeof next === 'number' && Number.isInteger(next) && next > offset ? next : null
}

/** Pages are contiguous slices of one ordered list, so concatenation keeps the host's order. */
export function combineAiVaultListPages(pages: readonly AiVaultListResult[]): AiVaultListResult {
  const first = pages.at(0)
  return {
    sessions: pages.flatMap((page) => page.sessions),
    issues: pages.flatMap((page) => page.issues),
    scannedAt: pages.at(-1)?.scannedAt ?? new Date().toISOString(),
    // Every page but the first carries no fingerprint; the listing's is page 0's.
    ...(first?.fingerprint ? { fingerprint: first.fingerprint } : {})
  }
}

/**
 * Drains one paged listing. `fetchPage` throws on a transport or shape failure, so a page that
 * fails after rows have arrived is reported as `partial` instead of discarding them.
 */
export async function readAiVaultListPages(args: {
  /** The caller's request, including the fingerprint/force that belong to page 0 alone. */
  firstPageArgs: AiVaultListArgs
  fetchPage: (pageArgs: AiVaultListArgs) => Promise<AiVaultListResult>
}): Promise<AiVaultListPageRead> {
  const pages: AiVaultListResult[] = []
  let offset = 0
  for (;;) {
    let result: AiVaultListResult
    try {
      result = await args.fetchPage(aiVaultListPageArgs(args.firstPageArgs, offset))
    } catch (error) {
      return pages.length === 0
        ? { kind: 'failed', error }
        : { kind: 'partial', result: combineAiVaultListPages(pages), error }
    }
    // An unchanged reply stands for the caller's previous body, and a delta reply carries the
    // changes to it; neither is a page of a listing.
    if (result.unchanged || result.syncDelta) {
      return { kind: 'complete', result }
    }
    pages.push(result)
    const next = aiVaultListNextOffset(result, offset)
    if (next === null) {
      return { kind: 'complete', result: combineAiVaultListPages(pages) }
    }
    if (pages.length >= AI_VAULT_LIST_MAX_PAGES) {
      return {
        kind: 'partial',
        result: combineAiVaultListPages(pages),
        error: new Error(AI_VAULT_LIST_TOO_MANY_PAGES_MESSAGE)
      }
    }
    offset = next
  }
}

/** The row a reader adds when later pages failed: the rows it has stay on screen, the rest does not. */
export function aiVaultPartialListIssue(args: {
  executionHostId: ExecutionHostId
  path: string
  error: unknown
}): AiVaultScanIssue {
  return {
    executionHostId: args.executionHostId,
    agent: 'codex',
    kind: 'host',
    path: args.path,
    message: `Only part of the session list loaded. ${describeAiVaultScanError(
      args.error instanceof Error ? args.error.message : String(args.error)
    )}`
  }
}
