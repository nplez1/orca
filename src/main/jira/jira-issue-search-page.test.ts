import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from './authenticated-request'
import { listIssuesPage, searchIssues, searchIssuesPage } from './jira-issue-search'

const { getClientsMock, jiraRequestMock } = vi.hoisted(() => ({
  getClientsMock: vi.fn(),
  jiraRequestMock: vi.fn()
}))
vi.mock('./client', () => ({
  getClients: (...args: unknown[]) => getClientsMock(...args),
  clearToken: vi.fn(),
  isAuthError: () => false
}))
vi.mock('./authenticated-request', () => ({
  apiBasePath: (site: { authType?: string }) =>
    site.authType === 'server' ? '/rest/api/2' : '/rest/api/3',
  jiraRequest: (...args: unknown[]) => jiraRequestMock(...args)
}))

function client(id: string, authType: 'cloud' | 'server' = 'cloud'): JiraClientForSite {
  return {
    site: {
      id,
      siteUrl: `https://${id}.atlassian.net`,
      email: '',
      displayName: id,
      accountId: 'viewer',
      authType
    },
    authorization: 'Basic fixture'
  }
}

function issueRecord(key: string) {
  return {
    id: key,
    key,
    fields: {
      summary: `${key} title`,
      status: { id: '1', name: 'Ready', statusCategory: { key: 'new', name: 'To Do' } },
      project: { id: 'project-1', key: 'ABC', name: 'Payments' },
      issuetype: { id: 'story', name: 'Story' },
      updated: '2026-09-02T00:00:00.000Z',
      created: '2026-09-01T00:00:00.000Z'
    }
  }
}

/** Every search body the client sent, in order, so a test can pin which cursor travelled. */
const sentBodies: Record<string, unknown>[] = []

/** Answers the agile-field catalog and hands each request to the caller. */
function servePages(
  answer: (ctx: { body: Record<string, unknown>; path: string; siteId: string }) => unknown
): void {
  jiraRequestMock.mockImplementation(
    async (entry: { site: { id: string } }, path: string, init?: { body?: string }) => {
      if (path.endsWith('/field')) {
        return []
      }
      const body: Record<string, unknown> = JSON.parse(String(init?.body ?? '{}'))
      sentBodies.push(body)
      return answer({ body, path, siteId: entry.site.id })
    }
  )
}

beforeEach(() => {
  sentBodies.length = 0
})

describe('Jira issue page reads', () => {
  it('carries the Cloud cursor and the query that produced it', async () => {
    getClientsMock.mockReturnValue([client('site-1')])
    servePages(() => ({ issues: [issueRecord('ABC-1')], isLast: false, nextPageToken: 'token-2' }))

    const first = await searchIssuesPage('project = ABC', 50, 'site-1')

    expect(first.issues.map((item) => item.key)).toEqual(['ABC-1'])
    expect(first.hasMore).toBe(true)
    expect(first.total).toBeNull()
    expect(first.continuation).toEqual({
      siteId: 'site-1',
      jql: 'project = ABC',
      pageToken: 'token-2',
      startAt: 0
    })

    servePages(() => ({ issues: [issueRecord('ABC-2')], isLast: true }))
    const second = await searchIssuesPage('project = ABC', 50, 'site-1', undefined, false, {
      pageToken: 'token-2',
      startAt: 0
    })

    expect(second.hasMore).toBe(false)
    expect(second.continuation).toBeNull()
    // Why: /search/jql pages by token only, so a Cloud read must never send an offset.
    expect(sentBodies.at(-1)).toMatchObject({ nextPageToken: 'token-2' })
    expect(sentBodies.at(-1)).not.toHaveProperty('startAt')
  })

  it('resumes a Server site by offset and reports the known total', async () => {
    getClientsMock.mockReturnValue([client('site-1', 'server')])
    servePages(() => ({
      issues: Array.from({ length: 50 }, (_, index) => issueRecord(`ABC-${index + 1}`)),
      startAt: 0,
      total: 312
    }))

    const page = await searchIssuesPage('project = ABC', 50, 'site-1')

    expect(page.issues).toHaveLength(50)
    expect(page.hasMore).toBe(true)
    expect(page.total).toBe(312)
    expect(page.continuation).toEqual({
      siteId: 'site-1',
      jql: 'project = ABC',
      pageToken: null,
      startAt: 50
    })

    servePages(() => ({ issues: [issueRecord('ABC-51')], startAt: 50, total: 312 }))
    await searchIssuesPage('project = ABC', 50, 'site-1', undefined, false, {
      pageToken: null,
      startAt: 50
    })

    // Why: /search pages by offset only; a token would be ignored and re-serve page 1.
    expect(sentBodies.at(-1)).toMatchObject({ startAt: 50 })
    expect(sentBodies.at(-1)).not.toHaveProperty('nextPageToken')
  })

  it('stops offering a page when the source says it is the last one', async () => {
    getClientsMock.mockReturnValue([client('site-1')])
    servePages(() => ({ issues: [issueRecord('ABC-1')], isLast: true }))

    const page = await listIssuesPage('assigned', 50, 'site-1')

    expect(page.hasMore).toBe(false)
    expect(page.continuation).toBeNull()
  })

  it('reports more issues across sites without pretending one cursor reaches them', async () => {
    getClientsMock.mockReturnValue([client('site-1'), client('site-2')])
    servePages(({ siteId }) =>
      siteId === 'site-1'
        ? { issues: [issueRecord('ABC-1')], isLast: false, nextPageToken: 'token-2' }
        : { issues: [issueRecord('DEF-1')], isLast: true }
    )

    const page = await searchIssuesPage('project = ABC', 50)

    expect(page.issues).toHaveLength(2)
    expect(page.hasMore).toBe(true)
    expect(page.total).toBeNull()
    expect(page.continuation).toBeNull()
  })

  it('refuses a cursor that would have to page several sites at once', async () => {
    getClientsMock.mockReturnValue([client('site-1'), client('site-2')])
    servePages(() => ({ issues: [issueRecord('ABC-1')], isLast: true }))

    await expect(
      searchIssuesPage('project = ABC', 50, undefined, undefined, false, {
        pageToken: 'token-2',
        startAt: 0
      })
    ).rejects.toThrow('Jira issue paging needs a single site.')
  })

  it('refuses a cursor for a preset that has to fan out over project chunks', async () => {
    getClientsMock.mockReturnValue([client('site-1')])
    servePages(() => ({ issues: [issueRecord('ABC-1')], isLast: true }))

    await expect(
      listIssuesPage('all', 50, 'site-1', false, undefined, { pageToken: 'token-2', startAt: 0 })
    ).rejects.toThrow('Jira issue paging needs the query that produced the page.')
  })

  it('reads one page for the array callers, so their cost does not change', async () => {
    getClientsMock.mockReturnValue([client('site-1')])
    servePages(() => ({
      issues: [issueRecord('ABC-1')],
      isLast: false,
      nextPageToken: 'token-2'
    }))

    const issues = await searchIssues('project = ABC', 50, 'site-1')

    expect(issues.map((item) => item.key)).toEqual(['ABC-1'])
    expect(sentBodies).toHaveLength(1)
  })

  it('keeps the Cloud all-preset fan-out to a notice once it spans several chunks', async () => {
    getClientsMock.mockReturnValue([client('site-1')])
    // 101 projects is two chunks, so no single cursor reaches the rest of either.
    const projectIds = Array.from({ length: 101 }, (_, index) => `project-${index + 1}`)
    servePages(({ path, body }) => {
      if (path.includes('/project/search')) {
        return {
          values: projectIds.map((id) => ({ id, key: id })),
          isLast: true,
          total: projectIds.length
        }
      }
      const firstId = String(body.jql).match(/project in \("([^"]+)"/)?.[1]
      return { issues: [issueRecord(`${firstId}-1`)], isLast: true }
    })

    const page = await listIssuesPage('all', 50, 'site-1')

    expect(page.issues).toHaveLength(2)
    expect(page.hasMore).toBe(false)
    expect(page.continuation).toBeNull()
  })

  it('continues a single-chunk Cloud all-preset read with that chunk cursor', async () => {
    getClientsMock.mockReturnValue([client('site-1')])
    servePages(({ path, body }) => {
      if (path.includes('/project/search')) {
        return { values: [{ id: 'project-1', key: 'ABC' }], isLast: true, total: 1 }
      }
      return { issues: [issueRecord('ABC-1')], isLast: false, nextPageToken: String(body.jql) }
    })

    const page = await listIssuesPage('all', 50, 'site-1')

    expect(page.hasMore).toBe(true)
    // Why the chunk JQL: page 2 must re-send the bounded query, not the bare preset.
    expect(page.continuation?.jql).toContain('project in ("project-1") AND')
    expect(page.continuation?.pageToken).toBe(page.continuation?.jql)
  })
})
