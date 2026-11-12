import type {
  JiraIssue,
  JiraIssueFilter,
  JiraIssueListFilters,
  JiraIssueSearchPage,
  JiraSiteSelection
} from '../../shared/jira/jira-types'
import { acquire, release } from './request-queue'
import type { JiraClientForSite } from './authenticated-request'
import { clearToken, getClients, isAuthError } from './client'
import { getAgileFieldIds } from './jira-agile-fields'
import type { JiraAgileFieldIds } from './jira-issue-mapping'
import {
  requireStrictJiraSite,
  shouldSurfaceSiteFailure,
  toIssueSearchFailureError,
  withJiraDeadline,
  type JiraIssueSearchFailure
} from './jira-read-failure'
import {
  clampJiraIssueSearchLimit,
  readIssuePageForClient,
  readIssuesForClient,
  sortAndLimitIssues,
  type JiraClientIssuePage,
  type JiraIssuePageCursor,
  type JiraIssueQuery
} from './jira-issue-page-reads'

const ISSUE_SEARCH_TIMEOUT_MS = 30_000

/** Runs one read per connected site, keeping a site's failure from erasing the others'. */
async function runPerSite<T>(
  entries: JiraClientForSite[],
  siteId: JiraSiteSelection | null | undefined,
  signal: AbortSignal | undefined,
  read: (
    entry: JiraClientForSite,
    agileFields: JiraAgileFieldIds,
    signal: AbortSignal
  ) => Promise<T>,
  failed: T
): Promise<T[]> {
  const failures: (JiraIssueSearchFailure | undefined)[] = Array.from({ length: entries.length })
  const surfaceSiteFailure = shouldSurfaceSiteFailure(siteId, entries.length)
  const results = await withJiraDeadline(signal, ISSUE_SEARCH_TIMEOUT_MS, (requestSignal) =>
    Promise.all(
      entries.map(async (entry, index) => {
        // Discovery owns a slot, so finish it before acquiring the search slot.
        const agileFields = await getAgileFieldIds(entry, requestSignal)
        // Pass cancellation through queue admission so abandoned searches do not occupy the shared pool.
        await acquire(requestSignal)
        try {
          return await read(entry, agileFields, requestSignal)
        } catch (error) {
          if (requestSignal.aborted) {
            // Abandoned by the caller: not a site failure, so don't clear tokens or mask a real one.
            throw error
          }
          const authFailure = isAuthError(error)
          if (authFailure) {
            clearToken(entry.site.id)
          }
          if (surfaceSiteFailure) {
            throw toIssueSearchFailureError(error)
          }
          console.warn('[jira] searchIssues failed:', error)
          failures[index] = { error: toIssueSearchFailureError(error), auth: authFailure }
          return failed
        } finally {
          release()
        }
      })
    )
  )
  // Preserve partial success, including empty results; report failure only when every connected site fails.
  const recordedFailures = failures.filter(
    (failure): failure is JiraIssueSearchFailure => failure !== undefined
  )
  if (recordedFailures.length === entries.length) {
    throw (recordedFailures.find((failure) => !failure.auth) ?? recordedFailures[0]).error
  }
  return results
}

function resolveEntries(
  siteId: JiraSiteSelection | null | undefined,
  strict: boolean
): JiraClientForSite[] {
  const entries = getClients(siteId)
  requireStrictJiraSite(entries, siteId, strict)
  return entries
}

export async function listIssues(
  filter: JiraIssueFilter = 'assigned',
  limit = 30,
  siteId?: JiraSiteSelection | null,
  strict = false,
  filters?: JiraIssueListFilters
): Promise<JiraIssue[]> {
  return runIssueSearch({ filter, filters }, limit, siteId, undefined, strict)
}

export async function searchIssues(
  jql: string,
  limit = 30,
  siteId?: JiraSiteSelection | null,
  signal?: AbortSignal,
  strict = false
): Promise<JiraIssue[]> {
  return runIssueSearch({ jql: jql.trim() }, limit, siteId, signal, strict)
}

export async function listIssuesPage(
  filter: JiraIssueFilter = 'assigned',
  limit = 30,
  siteId?: JiraSiteSelection | null,
  strict = false,
  filters?: JiraIssueListFilters,
  cursor?: JiraIssuePageCursor
): Promise<JiraIssueSearchPage> {
  return runIssuePageSearch({ filter, filters }, limit, siteId, undefined, strict, cursor)
}

export async function searchIssuesPage(
  jql: string,
  limit = 30,
  siteId?: JiraSiteSelection | null,
  signal?: AbortSignal,
  strict = false,
  cursor?: JiraIssuePageCursor
): Promise<JiraIssueSearchPage> {
  return runIssuePageSearch({ jql: jql.trim() }, limit, siteId, signal, strict, cursor)
}

async function runIssueSearch(
  query: JiraIssueQuery,
  limit: number,
  siteId?: JiraSiteSelection | null,
  signal?: AbortSignal,
  strict = false
): Promise<JiraIssue[]> {
  const entries = resolveEntries(siteId, strict)
  if (entries.length === 0 || ('jql' in query && !query.jql)) {
    return []
  }
  const safeLimit = clampJiraIssueSearchLimit(limit)
  const results = await runPerSite(
    entries,
    siteId,
    signal,
    (entry, agileFields, requestSignal) =>
      readIssuesForClient(entry, query, safeLimit, agileFields, requestSignal),
    [] as JiraIssue[]
  )
  return entries.length === 1
    ? results.flat().slice(0, safeLimit)
    : sortAndLimitIssues(results.flat(), safeLimit)
}

async function runIssuePageSearch(
  query: JiraIssueQuery,
  limit: number,
  siteId?: JiraSiteSelection | null,
  signal?: AbortSignal,
  strict = false,
  cursor?: JiraIssuePageCursor
): Promise<JiraIssueSearchPage> {
  const empty: JiraIssueSearchPage = { issues: [], hasMore: false, total: null, continuation: null }
  const entries = resolveEntries(siteId, strict)
  if (entries.length === 0 || ('jql' in query && !query.jql)) {
    return empty
  }
  // A cursor names one site's page; fanning it out would re-read every other site's first page.
  if (cursor && entries.length !== 1) {
    throw new Error('Jira issue paging needs a single site.')
  }
  const safeLimit = clampJiraIssueSearchLimit(limit)
  const failedPage: JiraClientIssuePage | null = null
  const pages = await runPerSite(
    entries,
    siteId,
    signal,
    (entry, agileFields, requestSignal) =>
      readIssuePageForClient(entry, query, safeLimit, agileFields, requestSignal, cursor),
    failedPage
  )
  const read = pages.filter((page): page is JiraClientIssuePage => page !== null)
  if (read.length === 0) {
    return empty
  }
  if (entries.length === 1) {
    const page = read[0]
    return {
      issues: page.issues.slice(0, safeLimit),
      hasMore: page.hasMore,
      total: page.total,
      continuation: page.cursor
        ? {
            siteId: entries[0].site.id,
            jql: page.jql,
            pageToken: page.cursor.pageToken,
            startAt: page.cursor.startAt
          }
        : null
    }
  }
  // Several sites have no shared cursor: their pages cannot be interleaved in updated order.
  const collected = read.flatMap((page) => page.issues)
  return {
    issues: sortAndLimitIssues(collected, safeLimit),
    hasMore: read.some((page) => page.hasMore) || collected.length > safeLimit,
    total: null,
    continuation: null
  }
}
