import {
  AI_VAULT_LIST_SKIP_ISSUE_PATH,
  AI_VAULT_SCAN_CANCELLED_MESSAGE,
  type AiVaultListArgs,
  type AiVaultListResult,
  type AiVaultScanIssue
} from './ai-vault-types'
import type { ExecutionHostId } from './execution-host'
import { aiVaultScanIssueText } from './ai-vault-scan-issue-copy'
import { describeAiVaultScanError } from './ai-vault-scan-error-message'

/**
 * A remote reply carries at most 4 MiB, so a listing with thousands of rows never fits one frame.
 * A paging client asks the host for bounded pages and drains them here, which is why only a
 * client that understands `hasMore`/`nextOffset` may send `paged` at all: an older client gets
 * today's single reply rather than a silently truncated list.
 */

/**
 * Progress guard, and a memory ceiling for the drain: 32 pages is ~64 MiB buffered (far past any
 * real history, which is thousands of ~1.5 KB rows), and a listing that large is reported partial
 * rather than held in the main process.
 */
export const AI_VAULT_LIST_MAX_PAGES = 32

export const AI_VAULT_LIST_TOO_MANY_PAGES_MESSAGE =
  'The session list was too large to load in one go. Refresh to try again.'

/** Restarts before a listing that keeps changing under the drain is reported instead of retried. */
export const AI_VAULT_LIST_MAX_SCAN_RESTARTS = 3

export const AI_VAULT_LIST_CHANGING_SCAN_MESSAGE =
  'The session list kept changing while it loaded. Refresh to try again.'

export const AI_VAULT_LIST_UNREADABLE_CURSOR_MESSAGE =
  'The session host returned a page list this client cannot follow. Refresh to try again.'

export const AI_VAULT_LIST_DEADLINE_MESSAGE =
  'Loading this session list took too long. Refresh to try again.'

export const AI_VAULT_LIST_UNEXPECTED_CONDITIONAL_MESSAGE =
  'The session host answered a page request with a whole-list reply. Refresh to try again.'

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
    // Why every page's issues: the host carries scan issues on page 0, but a page can also report
    // rows it had to skip, and dropping those would hide the only sign that rows are missing.
    issues: mergedSkipNotices(pages.flatMap((page) => page.issues)),
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
  /** Stops the drain once its caller walked away, instead of reading pages nobody will use. */
  signal?: AbortSignal
  /** Epoch ms after which the drain reports what it has; one slow host cannot hold a merge open. */
  deadlineMs?: number
}): Promise<AiVaultListPageRead> {
  let pages: AiVaultListResult[] = []
  let offset = 0
  let restarts = 0
  let pageArgs = args.firstPageArgs
  for (;;) {
    if (args.signal?.aborted) {
      // The caller walked away; the rows read so far are not worth reporting as a failure.
      const aborted = new Error(AI_VAULT_SCAN_CANCELLED_MESSAGE)
      aborted.name = 'AbortError'
      return incomplete(pages, aborted)
    }
    if (args.deadlineMs !== undefined && Date.now() > args.deadlineMs) {
      return incomplete(pages, new Error(AI_VAULT_LIST_DEADLINE_MESSAGE))
    }
    // One request object for the fetch and for vetting the reply: what a page may answer depends
    // on what that page actually asked, and later pages carry no fingerprints.
    const requestArgs = aiVaultListPageArgs(pageArgs, offset)
    let result: AiVaultListResult
    try {
      result = await args.fetchPage(requestArgs)
    } catch (error) {
      return pages.length === 0
        ? { kind: 'failed', error }
        : { kind: 'partial', result: partialAiVaultList(pages), error }
    }
    // An unchanged reply stands for the caller's previous body, and a delta reply carries the
    // changes to it; neither is a page of a listing. Each answers a fingerprint this request had
    // to carry — a page after a restart carries none, so a conditional reply there names a list
    // nobody asked about and must not be applied.
    if (result.unchanged || result.syncDelta) {
      const askedForConditional =
        result.syncDelta !== undefined
          ? requestArgs.syncFromFingerprint !== undefined
          : requestArgs.afterFingerprint !== undefined && requestArgs.afterFingerprint !== null
      return askedForConditional
        ? { kind: 'complete', result }
        : incomplete(pages, new Error(AI_VAULT_LIST_UNEXPECTED_CONDITIONAL_MESSAGE))
    }
    // Why: pages are row offsets, so appending one sliced from a *different* scan of the same
    // scope both duplicates and skips rows — and a delta computed later would never re-send the
    // skipped ones, because their digests never changed. Start the listing again instead.
    const token = result.listToken
    if (token !== undefined && pages.length > 0 && token !== pages[0]?.listToken) {
      if (restarts >= AI_VAULT_LIST_MAX_SCAN_RESTARTS) {
        return {
          kind: 'partial',
          result: partialAiVaultList(pages),
          error: new Error(AI_VAULT_LIST_CHANGING_SCAN_MESSAGE)
        }
      }
      restarts += 1
      pages = []
      offset = 0
      // Why drop all three: a restart only needs page 0 of a fresh listing. Re-forcing would
      // rescan the host for one click, and keeping the fingerprints would let the restart answer
      // `unchanged` or a delta — exactly what a forced refresh exists to get past.
      const {
        force: _force,
        afterFingerprint: _fingerprint,
        syncFromFingerprint: _sync,
        ...restarted
      } = pageArgs
      pageArgs = restarted
      continue
    }
    pages.push(result)
    const next = aiVaultListNextOffset(result, offset)
    if (next === null) {
      // Why not "the listing ends here": rows are still missing and the caller has to be told,
      // or a bad cursor would quietly truncate the list it shows.
      return result.hasMore === true
        ? {
            kind: 'partial',
            result: partialAiVaultList(pages),
            error: new Error(AI_VAULT_LIST_UNREADABLE_CURSOR_MESSAGE)
          }
        : { kind: 'complete', result: combineAiVaultListPages(pages) }
    }
    if (pages.length >= AI_VAULT_LIST_MAX_PAGES) {
      return {
        kind: 'partial',
        result: partialAiVaultList(pages),
        error: new Error(AI_VAULT_LIST_TOO_MANY_PAGES_MESSAGE)
      }
    }
    offset = next
  }
}

/** The one notice shape this module re-counts; anything else is left exactly as it arrived. */
const SKIP_NOTICE_MESSAGE =
  /^Skipped (\d+) invalid Agent Session History result (?:entry|entries)\.$/

/**
 * Pages each report the entries they had to skip, so one listing would otherwise show a notice per
 * page. They are summed into one, which needs no state of its own: a notice that does not match the
 * known shape is left alone rather than guessed at.
 */
function mergedSkipNotices(issues: readonly AiVaultScanIssue[]): AiVaultScanIssue[] {
  const skips = issues.filter((issue) => issue.path === AI_VAULT_LIST_SKIP_ISSUE_PATH)
  if (skips.length < 2) {
    return [...issues]
  }
  let total = 0
  for (const skip of skips) {
    const counted = SKIP_NOTICE_MESSAGE.exec(skip.message.trim())
    if (!counted) {
      return [...issues]
    }
    total += Number(counted[1])
  }
  const [firstSkip] = skips
  return [
    ...issues.filter((issue) => issue.path !== AI_VAULT_LIST_SKIP_ISSUE_PATH),
    {
      ...firstSkip!,
      // Rebuilt from the code, not re-messaged: the display prefers code+params over `message`, so a
      // stale `messageParams.count` from the first page would win over the sum.
      ...aiVaultScanIssueText('invalidResultsSkipped', { params: { count: total } })
    }
  ]
}

function incomplete(pages: readonly AiVaultListResult[], error: Error): AiVaultListPageRead {
  return pages.length === 0
    ? { kind: 'failed', error }
    : { kind: 'partial', result: partialAiVaultList(pages), error }
}

/**
 * Why no fingerprint: it names the whole listing, and a caller that reused it would ask "is my
 * body current?" about rows it never received — the host then answers `unchanged` to a body that
 * will never complete.
 */
function partialAiVaultList(pages: readonly AiVaultListResult[]): AiVaultListResult {
  const { fingerprint: _fingerprint, ...rest } = combineAiVaultListPages(pages)
  return rest
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
