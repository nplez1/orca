import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../../types'
import type { JiraIssue, JiraIssueSearchPage } from '../../../../../shared/jira/jira-types'
import { createJiraSlice } from './jira'

const jiraSearchIssues = vi.fn()
const jiraListIssues = vi.fn()
const jiraSearchIssuesPage = vi.fn()
const jiraListIssuesPage = vi.fn()

vi.mock('@/runtime/jira/runtime-jira-client', () => ({
  jiraAddIssueComment: vi.fn(),
  jiraConnect: vi.fn(),
  jiraDisconnect: vi.fn(),
  jiraGetIssue: vi.fn(),
  jiraIssueComments: vi.fn(),
  jiraListCreateFields: vi.fn(),
  jiraListIssueTypes: vi.fn(),
  jiraListIssues: (...args: unknown[]) => jiraListIssues(...args),
  jiraListIssuesForTarget: (...args: unknown[]) => jiraListIssues(...args),
  jiraListIssuesPage: (...args: unknown[]) => jiraListIssuesPage(...args),
  jiraListIssuesPageForTarget: (...args: unknown[]) => jiraListIssuesPage(...args),
  jiraListPriorities: vi.fn(),
  jiraListProjects: vi.fn(),
  jiraSearchIssues: (...args: unknown[]) => jiraSearchIssues(...args),
  jiraSearchIssuesPage: (...args: unknown[]) => jiraSearchIssuesPage(...args),
  jiraSelectSite: vi.fn(),
  jiraStatus: vi.fn(),
  jiraTestConnection: vi.fn(),
  jiraUpdateIssue: vi.fn()
}))
vi.mock('@/runtime/jira/runtime-jira-user-fields-client', () => ({ jiraCreateIssue: vi.fn() }))
vi.mock('@/runtime/jira/runtime-jira-summary-client', () => ({
  jiraLookupIssueSummary: vi.fn(),
  jiraReadStatus: vi.fn()
}))

function createTestStore() {
  return create<AppState>()((...a) => {
    const slice: Partial<AppState> = { settings: null, ...createJiraSlice(...a) }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test builds the whole store from the slice under test plus a null settings, as the sibling suite does.
    return slice as AppState
  })
}

function issue(key: string): JiraIssue {
  return {
    id: key,
    key,
    title: key,
    url: `https://example.atlassian.net/browse/${key}`,
    siteId: 'site-1',
    siteName: 'Example Jira',
    project: { id: '10000', key: 'ALP', name: 'Alpha', siteId: 'site-1' },
    issueType: { id: '10001', name: 'Bug' },
    status: { id: '1', name: 'Todo', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

function page(keys: string[], overrides: Partial<JiraIssueSearchPage> = {}): JiraIssueSearchPage {
  return {
    issues: keys.map(issue),
    hasMore: false,
    total: null,
    continuation: null,
    ...overrides
  }
}

function store() {
  const store = createTestStore()
  store.setState({ jiraStatus: { connected: true, viewer: null, selectedSiteId: 'site-1' } })
  return store
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Jira list page reads', () => {
  it('caches the issues where array reads cache theirs, with the page beside them', async () => {
    const app = store()
    const continuation = {
      siteId: 'site-1',
      jql: 'project = ALP',
      pageToken: 'token-2',
      startAt: 0
    }
    jiraSearchIssuesPage.mockResolvedValue(page(['ALP-1'], { hasMore: true, continuation }))

    await expect(app.getState().searchJiraIssuePage('project = ALP', 50)).resolves.toMatchObject({
      hasMore: true
    })

    expect(app.getState().jiraSearchCache['site-1::project = ALP::50']).toMatchObject({
      data: [{ key: 'ALP-1' }],
      page: { hasMore: true, continuation }
    })

    jiraSearchIssuesPage.mockResolvedValue(page(['ALP-OTHER']))
    await expect(app.getState().searchJiraIssuePage('project = ALP', 50)).resolves.toMatchObject({
      issues: [{ key: 'ALP-1' }],
      hasMore: true
    })
    expect(jiraSearchIssuesPage).toHaveBeenCalledTimes(1)
  })

  it('treats an entry an array read wrote as a miss, because it cannot report truncation', async () => {
    const app = store()
    jiraSearchIssues.mockResolvedValue([issue('ALP-1')])
    jiraSearchIssuesPage.mockResolvedValue(page(['ALP-2'], { hasMore: true }))

    await app.getState().searchJiraIssues('project = ALP', 50)
    expect(app.getState().jiraSearchCache['site-1::project = ALP::50']?.page).toBeUndefined()

    await expect(app.getState().searchJiraIssuePage('project = ALP', 50)).resolves.toMatchObject({
      issues: [{ key: 'ALP-2' }],
      hasMore: true
    })
    expect(jiraSearchIssuesPage).toHaveBeenCalledTimes(1)
  })

  it('reads the next list page through the preset filter and keeps its metadata', async () => {
    const app = store()
    jiraListIssuesPage.mockResolvedValue(page(['ALP-1'], { hasMore: true, total: 312 }))

    await expect(app.getState().listJiraIssuePage('assigned', 50)).resolves.toMatchObject({
      total: 312
    })

    expect(jiraListIssuesPage).toHaveBeenLastCalledWith(
      expect.anything(),
      'assigned',
      50,
      'site-1',
      undefined
    )
  })

  it('resumes from the continuation it was handed and never caches that page', async () => {
    const app = store()
    const continuation = {
      siteId: 'site-1',
      jql: 'project in ("1") AND x',
      pageToken: null,
      startAt: 50
    }
    jiraSearchIssuesPage.mockResolvedValue(page(['ALP-51']))

    await expect(app.getState().loadMoreJiraIssues(continuation, 50)).resolves.toMatchObject({
      issues: [{ key: 'ALP-51' }]
    })

    expect(jiraSearchIssuesPage).toHaveBeenLastCalledWith(
      expect.anything(),
      continuation.jql,
      50,
      'site-1',
      undefined,
      { pageToken: null, startAt: 50 }
    )
    expect(app.getState().jiraSearchCache['site-1::project in ("1") AND x::50']).toBeUndefined()
  })

  it('fails a load-more it cannot authenticate instead of reporting the list complete', async () => {
    const app = store()
    jiraSearchIssuesPage.mockRejectedValue(new Error('401 unauthorized'))

    await expect(
      app
        .getState()
        .loadMoreJiraIssues(
          { siteId: 'site-1', jql: 'project = ALP', pageToken: 'token-2', startAt: 0 },
          50
        )
    ).rejects.toThrow('401 unauthorized')
  })

  it('records appended rows where a later patch can find them, under no reader key', async () => {
    const app = store()
    const continuation = {
      siteId: 'site-1',
      jql: 'project = ALP',
      pageToken: 'token-2',
      startAt: 0
    }
    jiraSearchIssuesPage.mockResolvedValue(page(['ALP-51']))

    await app.getState().loadMoreJiraIssues(continuation, 50)

    const key = 'site-1::project = ALP::50::page::token-2'
    expect(app.getState().jiraSearchCache[key]?.data).toMatchObject([{ key: 'ALP-51' }])
    // Why no page metadata: a page read must not be answered with these rows alone.
    expect(app.getState().jiraSearchCache[key]?.page).toBeUndefined()

    jiraSearchIssuesPage.mockResolvedValue(page(['ALP-1'], { hasMore: true }))
    await app.getState().searchJiraIssuePage('project = ALP', 50)
    expect(jiraSearchIssuesPage).toHaveBeenLastCalledWith(
      expect.anything(),
      'project = ALP',
      50,
      'site-1',
      undefined
    )
  })
})
