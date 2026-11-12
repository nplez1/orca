import { sortByUpdatedAtDescending } from '../../shared/updated-at-order'
import type { JiraIssue, JiraIssueFilter, JiraIssueListFilters } from '../../shared/jira/jira-types'
import { buildJiraPresetJql } from '../../shared/jira/jira-preset-jql'
import { apiBasePath, jiraRequest, type JiraClientForSite } from './authenticated-request'
import { ISSUE_LIST_FIELDS, mapJiraIssue, type JiraAgileFieldIds } from './jira-issue-mapping'
import { agileFieldIdList } from './jira-agile-fields'
import { asFiniteNumber, resolveJiraPageIsLast, type JiraSearchResponse } from './jira-record-pages'
import { readProjectsForClient } from './jira-project-queries'

const PROJECTS_PER_QUERY = 100

export type JiraIssueQuery =
  | { filter: JiraIssueFilter; filters?: JiraIssueListFilters }
  | { jql: string }

/** Where the next page starts. Cloud pages by token, Server/DC by offset. */
export type JiraIssuePageCursor = { pageToken: string | null; startAt: number }

export type JiraClientIssuePage = {
  issues: JiraIssue[]
  hasMore: boolean
  total: number | null
  jql: string
  /** Null when the source is exhausted, or reported more issues without a way to reach them. */
  cursor: JiraIssuePageCursor | null
}

export function clampJiraIssueSearchLimit(limit: number | undefined, fallback = 30): number {
  return Math.min(Math.max(1, Number.isFinite(limit) ? Number(limit) : fallback), 100)
}

export function sortAndLimitIssues(issues: JiraIssue[], limit: number): JiraIssue[] {
  return sortByUpdatedAtDescending(issues).slice(0, limit)
}
/** Cloud requires a search restriction; bounding the query by project preserves older open
 *  work. Returns null for every request that needs no fan-out. */
function needsProjectChunkFanOut(
  entry: JiraClientForSite,
  query: JiraIssueQuery
): query is { filter: JiraIssueFilter; filters?: JiraIssueListFilters } {
  return !('jql' in query) && query.filter === 'all' && entry.site.authType !== 'server'
}

async function resolveProjectChunkJql(
  entry: JiraClientForSite,
  query: JiraIssueQuery,
  signal: AbortSignal
): Promise<string[] | null> {
  if (!needsProjectChunkFanOut(entry, query)) {
    return null
  }
  const projects = await readProjectsForClient(entry, signal, true)
  const projectIds = [...new Set(projects.map((project) => project.id || project.key))]
  if (projectIds.some((id) => !id)) {
    throw new Error('Jira returned a project without an ID or key.')
  }
  const presetJql = buildJiraPresetJql(query.filter, query.filters)
  const chunks: string[] = []
  for (let start = 0; start < projectIds.length; start += PROJECTS_PER_QUERY) {
    const ids = projectIds.slice(start, start + PROJECTS_PER_QUERY).map((id) => JSON.stringify(id))
    chunks.push(`project in (${ids.join(', ')}) AND ${presetJql}`)
  }
  return chunks
}

async function searchIssuePageForClient(
  entry: JiraClientForSite,
  jql: string,
  limit: number,
  agileFields: JiraAgileFieldIds,
  signal: AbortSignal | undefined,
  cursor?: JiraIssuePageCursor,
  requirePage = false
): Promise<JiraClientIssuePage> {
  // Server/DC only has the classic /search resource; /search/jql is Cloud-only.
  const server = entry.site.authType === 'server'
  const searchPath = server ? `${apiBasePath(entry.site)}/search` : '/rest/api/3/search/jql'
  const requestedStartAt = cursor?.startAt ?? 0
  const pageToken = cursor?.pageToken ?? null
  const result = await jiraRequest<JiraSearchResponse>(entry, searchPath, {
    method: 'POST',
    body: JSON.stringify({
      jql,
      maxResults: limit,
      fields: [...ISSUE_LIST_FIELDS, ...agileFieldIdList(agileFields)],
      // Why per generation: /search/jql pages by token and ignores startAt; /search pages
      // by offset and has no token, so sending the other one would re-read page 1 forever.
      ...(server
        ? requestedStartAt > 0
          ? { startAt: requestedStartAt }
          : {}
        : pageToken
          ? { nextPageToken: pageToken }
          : {})
    }),
    signal
  })
  if (requirePage && !Array.isArray(result.issues)) {
    throw new Error('Jira returned an invalid issue page.')
  }
  const issues = (result.issues ?? []).map((issue) =>
    mapJiraIssue(entry.site, issue, undefined, agileFields)
  )
  const startAt = asFiniteNumber(result.startAt) ?? requestedStartAt
  const total = asFiniteNumber(result.total)
  const nextPageToken =
    typeof result.nextPageToken === 'string' && result.nextPageToken ? result.nextPageToken : null
  const isLast = resolveJiraPageIsLast({
    issueCount: issues.length,
    maxResults: limit,
    startAt,
    total,
    isLast: result.isLast,
    nextPageToken
  })
  const nextCursor: JiraIssuePageCursor | null = isLast
    ? null
    : server
      ? { pageToken: null, startAt: startAt + issues.length }
      : nextPageToken
        ? { pageToken: nextPageToken, startAt: 0 }
        : null
  return { issues, hasMore: !isLast, total, jql, cursor: nextCursor }
}

export async function readIssuePageForClient(
  entry: JiraClientForSite,
  query: JiraIssueQuery,
  limit: number,
  agileFields: JiraAgileFieldIds,
  signal: AbortSignal,
  cursor?: JiraIssuePageCursor,
  requirePage = false
): Promise<JiraClientIssuePage> {
  if (cursor && needsProjectChunkFanOut(entry, query)) {
    // Why refuse: a chunk cursor is only meaningful for that chunk's bounded JQL, and the
    // bare preset query is one Cloud rejects outright.
    throw new Error('Jira issue paging needs the query that produced the page.')
  }
  // A cursor belongs to the one query that produced it, so only a first page may fan out.
  const chunks = cursor ? null : await resolveProjectChunkJql(entry, query, signal)
  if (chunks) {
    const pages: JiraClientIssuePage[] = []
    for (const chunkJql of chunks) {
      pages.push(
        await searchIssuePageForClient(
          entry,
          chunkJql,
          limit,
          agileFields,
          signal,
          undefined,
          requirePage
        )
      )
    }
    const collected = pages.flatMap((page) => page.issues)
    const single = chunks.length === 1 ? pages[0] : null
    return {
      issues: sortAndLimitIssues(collected, limit),
      hasMore: pages.some((page) => page.hasMore) || collected.length > limit,
      total: single ? single.total : null,
      jql: single ? single.jql : '',
      cursor: single ? single.cursor : null
    }
  }
  const jql = 'jql' in query ? query.jql : buildJiraPresetJql(query.filter, query.filters)
  return searchIssuePageForClient(entry, jql, limit, agileFields, signal, cursor, requirePage)
}

/** Follows the cursor until `limit` issues are collected or the source is exhausted. */
async function collectIssuesForClient(
  entry: JiraClientForSite,
  query: JiraIssueQuery,
  limit: number,
  agileFields: JiraAgileFieldIds,
  signal: AbortSignal
): Promise<JiraIssue[]> {
  const issues: JiraIssue[] = []
  const seenCursors = new Set<string>()
  let cursor: JiraIssuePageCursor | undefined
  for (let page = 0; page < 100; page += 1) {
    const result = await readIssuePageForClient(
      entry,
      query,
      limit - issues.length,
      agileFields,
      signal,
      cursor,
      true
    )
    issues.push(...result.issues)
    if (issues.length >= limit || !result.hasMore) {
      return issues.slice(0, limit)
    }
    if (!result.cursor) {
      throw new Error('Jira returned an incomplete issue page.')
    }
    const cursorKey = `${result.cursor.pageToken ?? ''}::${result.cursor.startAt}`
    if (seenCursors.has(cursorKey)) {
      throw new Error('Jira returned an invalid or repeated issue page token.')
    }
    seenCursors.add(cursorKey)
    cursor = result.cursor
  }
  throw new Error('Jira issue search exceeded the page limit. Select a project with JQL instead.')
}

export async function readIssuesForClient(
  entry: JiraClientForSite,
  query: JiraIssueQuery,
  limit: number,
  agileFields: JiraAgileFieldIds,
  signal: AbortSignal
): Promise<JiraIssue[]> {
  const chunks = await resolveProjectChunkJql(entry, query, signal)
  if (!chunks) {
    // One page, as the array reads always asked for: a caller that wants more asks for a
    // bigger limit, so following a cursor here would change every existing caller's cost.
    const page = await readIssuePageForClient(entry, query, limit, agileFields, signal)
    return page.issues.slice(0, limit)
  }
  const issues: JiraIssue[] = []
  for (const chunkJql of chunks) {
    issues.push(
      ...(await collectIssuesForClient(entry, { jql: chunkJql }, limit, agileFields, signal))
    )
  }
  return sortAndLimitIssues(issues, limit)
}
