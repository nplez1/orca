import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from './authenticated-request'

const {
  clearTokenMock,
  getClientsMock,
  isAuthErrorMock,
  jiraRequestMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  clearTokenMock: vi.fn(),
  getClientsMock: vi.fn(),
  isAuthErrorMock: vi.fn(),
  jiraRequestMock: vi.fn(),
  acquireMock: vi.fn().mockResolvedValue(undefined),
  releaseMock: vi.fn()
}))

vi.mock('./request-queue', () => ({ acquire: acquireMock, release: releaseMock }))
vi.mock('./authenticated-request', () => ({
  apiBasePath: (site: { authType?: string }) =>
    site.authType === 'server' ? '/rest/api/2' : '/rest/api/3',
  jiraRequest: (...args: unknown[]) => jiraRequestMock(...args)
}))
vi.mock('./client', () => ({
  clearToken: (...args: unknown[]) => clearTokenMock(...args),
  getClients: (...args: unknown[]) => getClientsMock(...args),
  getSingleClient: (selection?: unknown) => {
    const entries = getClientsMock(selection)
    if (entries.length !== 1) {
      throw new Error('A single Jira site is required for board data.')
    }
    return entries[0]
  },
  isAuthError: (...args: unknown[]) => isAuthErrorMock(...args)
}))

function makeEntry(): JiraClientForSite {
  return {
    site: {
      id: 'site-1',
      siteUrl: 'https://example.atlassian.net',
      email: 'ada@example.com',
      displayName: 'Example Jira',
      accountId: 'account-1'
    },
    authorization: 'Basic token'
  }
}

function makeServerEntry(): JiraClientForSite {
  return {
    site: {
      id: 'server-1',
      siteUrl: 'https://jira.example.com',
      email: '',
      displayName: 'Self-hosted Jira',
      accountId: 'ada',
      authType: 'server'
    },
    authorization: 'Bearer token'
  }
}

function issueRecord() {
  return {
    id: '1001',
    key: 'ABC-1',
    fields: {
      summary: 'Move payments work',
      project: { id: 'project-1', key: 'ABC', name: 'Payments' },
      issuetype: { id: 'story', name: 'Story' },
      status: { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      labels: [],
      created: '2026-09-01T00:00:00.000Z',
      updated: '2026-09-02T00:00:00.000Z'
    }
  }
}

const ROLE_FIELD_CATALOG = [
  { id: 'customfield_71', name: 'Dev', schema: { type: 'user' } },
  { id: 'customfield_72', name: 'QE', schema: { type: 'user' } }
]

/** A board issue read discovers the site's role fields before it asks for the page, so
 *  the page response is routed by path rather than by call order. */
function mockBoardIssueReads(
  page: unknown,
  catalog: readonly unknown[] = ROLE_FIELD_CATALOG
): void {
  jiraRequestMock.mockImplementation((_entry: unknown, path: unknown) =>
    Promise.resolve(String(path).endsWith('/field') ? catalog : page)
  )
}

function fieldCatalogCallCount(): number {
  return jiraRequestMock.mock.calls.filter((entry) => String(entry[1]).endsWith('/field')).length
}

function boardIssueCallUrl(): string {
  const call = jiraRequestMock.mock.calls.find((entry) => String(entry[1]).includes('/board/'))
  return String(call?.[1])
}

async function expectSettingsReadTimeout(read: () => Promise<unknown>): Promise<void> {
  vi.useFakeTimers()
  try {
    jiraRequestMock.mockImplementation(
      (_entry: unknown, _path: unknown, init: RequestInit | undefined) =>
        new Promise<never>((_resolve, reject) => {
          const signal = init?.signal
          if (!signal) {
            reject(new Error('Expected a Jira settings request to be abortable.'))
            return
          }
          signal.addEventListener('abort', () => reject(new Error('Jira request aborted')), {
            once: true
          })
        })
    )
    const pendingRead = read()
    const rejection = expect(pendingRead).rejects.toThrow('request timed out')

    await vi.advanceTimersByTimeAsync(30_000)

    await rejection
    expect(acquireMock).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(releaseMock).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
  }
}

describe('Jira board queries', () => {
  beforeEach(() => {
    // The field-catalog cache is module state with a 10-minute TTL, so without this a
    // test would read whichever catalog an earlier test in the file happened to prime.
    vi.resetModules()
    vi.clearAllMocks()
    isAuthErrorMock.mockReturnValue(false)
    getClientsMock.mockReturnValue([makeEntry()])
    jiraRequestMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    releaseMock.mockImplementation(() => {})
  })

  it('reads one board page with the site identity instead of paging the whole site', async () => {
    // A large self-hosted site answers `total: 5000+`; paging it took ~74s and still
    // missed the board being picked, so the read must stop after the first page.
    jiraRequestMock.mockResolvedValueOnce({
      startAt: 0,
      maxResults: 50,
      total: 5000,
      isLast: false,
      values: [
        { id: 42, name: 'Payments', type: 'scrum' },
        { id: 43, name: 'Payments Archive', type: 'kanban' }
      ]
    })
    const { listBoards } = await import('./jira-board-queries')

    await expect(listBoards('site-1')).resolves.toEqual([
      {
        id: '42',
        name: 'Payments',
        type: 'scrum',
        siteId: 'site-1',
        siteName: 'Example Jira'
      },
      {
        id: '43',
        name: 'Payments Archive',
        type: 'kanban',
        siteId: 'site-1',
        siteName: 'Example Jira'
      }
    ])
    expect(jiraRequestMock.mock.calls.map((call) => call[1])).toEqual([
      '/rest/agile/1.0/board?maxResults=50'
    ])
  })

  it('filters boards by name server-side when the picker searches', async () => {
    jiraRequestMock.mockResolvedValueOnce({
      startAt: 0,
      maxResults: 50,
      isLast: true,
      values: [{ id: 37169, name: 'Ps Nebulite Scrum Board', type: 'scrum' }]
    })
    const { listBoards } = await import('./jira-board-queries')

    await expect(listBoards('site-1', '  Nebulite  ')).resolves.toEqual([
      {
        id: '37169',
        name: 'Ps Nebulite Scrum Board',
        type: 'scrum',
        siteId: 'site-1',
        siteName: 'Example Jira'
      }
    ])
    expect(jiraRequestMock.mock.calls[0][1]).toBe(
      '/rest/agile/1.0/board?maxResults=50&name=Nebulite'
    )
  })

  it('times out a stalled board list read and releases its request slot', async () => {
    const { listBoards } = await import('./jira-board-queries')

    await expectSettingsReadTimeout(() => listBoards('site-1'))
  })

  it('loads board columns, the sprint tab, and every assignable sprint for Scrum boards', async () => {
    jiraRequestMock
      .mockResolvedValueOnce({ id: 42, name: 'Payments', type: 'scrum' })
      .mockResolvedValueOnce({
        columnConfig: {
          columns: [
            { name: 'Ready', statuses: [{ id: '1' }, { id: '2' }] },
            { name: 'In progress', statuses: [{ id: '3' }] }
          ]
        }
      })
      .mockResolvedValueOnce({
        values: [
          {
            id: 87,
            name: 'September sprint',
            state: 'active',
            startDate: '2026-09-01T00:00:00.000Z',
            originBoardId: 42
          },
          {
            id: 88,
            name: 'October sprint',
            state: 'future',
            startDate: '2026-10-01T00:00:00.000Z',
            originBoardId: 42
          }
        ],
        isLast: true
      })
    const { getBoardOverview } = await import('./jira-board-queries')

    await expect(getBoardOverview('42', 'site-1')).resolves.toEqual({
      board: {
        id: '42',
        name: 'Payments',
        type: 'scrum',
        siteId: 'site-1',
        siteName: 'Example Jira'
      },
      columns: [
        { name: 'Ready', statusIds: ['1', '2'] },
        { name: 'In progress', statusIds: ['3'] }
      ],
      activeSprints: [
        {
          id: '87',
          name: 'September sprint',
          state: 'active',
          startDate: '2026-09-01T00:00:00.000Z',
          endDate: undefined,
          boardId: '42'
        }
      ],
      // The sprint picker offers the future sprint a backlog item would go to.
      sprints: [
        {
          id: '87',
          name: 'September sprint',
          state: 'active',
          startDate: '2026-09-01T00:00:00.000Z',
          endDate: undefined,
          boardId: '42'
        },
        {
          id: '88',
          name: 'October sprint',
          state: 'future',
          startDate: '2026-10-01T00:00:00.000Z',
          endDate: undefined,
          boardId: '42'
        }
      ]
    })
    expect(jiraRequestMock.mock.calls.map((call) => call[1])).toEqual([
      '/rest/agile/1.0/board/42',
      '/rest/agile/1.0/board/42/configuration',
      '/rest/agile/1.0/board/42/sprint?state=active%2Cfuture&startAt=0&maxResults=50'
    ])
  })

  it('does not request sprints for Kanban boards', async () => {
    jiraRequestMock
      .mockResolvedValueOnce({ id: 44, name: 'Triage', type: 'kanban' })
      .mockResolvedValueOnce({ columnConfig: { columns: [] } })
    const { getBoardOverview } = await import('./jira-board-queries')

    await expect(getBoardOverview('44', 'site-1')).resolves.toMatchObject({
      board: { type: 'kanban' },
      activeSprints: [],
      sprints: []
    })
    expect(jiraRequestMock).toHaveBeenCalledTimes(2)
  })

  it('reads a board-filter backlog page', async () => {
    mockBoardIssueReads({
      startAt: 100,
      maxResults: 25,
      total: 130,
      isLast: false,
      nextPageToken: 'next-page',
      issues: [issueRecord()]
    })
    const { listBoardIssues } = await import('./jira-board-queries')

    await expect(
      listBoardIssues({
        boardId: '42',
        siteId: 'site-1',
        scope: 'backlog',
        startAt: 100,
        pageToken: 'previous-page',
        maxResults: 25
      })
    ).resolves.toMatchObject({
      startAt: 100,
      nextPageToken: 'next-page',
      total: 130,
      isLast: false,
      issues: [
        {
          key: 'ABC-1',
          status: { id: '3', name: 'In Progress' }
        }
      ]
    })
    const url = boardIssueCallUrl()
    expect(url).toContain('/rest/software/1.0/board/42/backlog?')
    expect(url).toContain('nextPageToken=previous-page')
    expect(url).toContain('maxResults=25')
  })

  it('asks for the site role fields and maps their users onto every board issue', async () => {
    const record = issueRecord()
    mockBoardIssueReads({
      startAt: 0,
      maxResults: 50,
      total: 1,
      isLast: true,
      issues: [
        {
          ...record,
          fields: {
            ...record.fields,
            customfield_71: { accountId: 'account-dev', displayName: 'Dev Name' },
            customfield_72: null
          }
        }
      ]
    })
    const { listBoardIssues } = await import('./jira-board-queries')

    const page = await listBoardIssues({ boardId: '42', siteId: 'site-1', scope: 'backlog' })

    const requested = decodeURIComponent(boardIssueCallUrl())
    expect(fieldCatalogCallCount()).toBe(1)
    expect(requested).toContain('fields=')
    expect(requested).toContain('customfield_71')
    expect(requested).toContain('customfield_72')
    expect(page.issues[0]?.roleAssignees).toEqual([
      { accountId: 'account-dev', displayName: 'Dev Name' }
    ])
  })

  it('still loads the page on the assignee fields alone when the catalog read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      jiraRequestMock.mockImplementation((_entry: unknown, path: unknown) => {
        if (String(path).endsWith('/field')) {
          return Promise.reject(new Error('field catalog unavailable'))
        }
        return Promise.resolve({
          startAt: 0,
          maxResults: 50,
          total: 1,
          isLast: true,
          issues: [issueRecord()]
        })
      })
      const { listBoardIssues } = await import('./jira-board-queries')

      const page = await listBoardIssues({ boardId: '42', siteId: 'site-1', scope: 'backlog' })

      expect(page.issues.map((entry) => entry.key)).toEqual(['ABC-1'])
      expect(decodeURIComponent(boardIssueCallUrl())).not.toContain('customfield_')
      expect(page.issues[0]?.roleAssignees).toBeUndefined()
      // The board's own "Me" answer degrades here, so it must not be silent.
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('asks for no role fields when the site declares more than the request can carry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // 260 ids join to 4,679 characters, past the board's 4 KB request budget.
      const crowded = Array.from({ length: 260 }, (_, index) => ({
        id: `customfield_${70000 + index}`,
        name: `Role ${index}`,
        schema: { type: 'user' }
      }))
      mockBoardIssueReads(
        { startAt: 0, maxResults: 50, total: 1, isLast: true, issues: [issueRecord()] },
        crowded
      )
      const { listBoardIssues } = await import('./jira-board-queries')

      const request = { boardId: '42', siteId: 'site-1', scope: 'backlog' } as const
      await listBoardIssues(request)
      const firstUrl = decodeURIComponent(boardIssueCallUrl())
      expect(firstUrl).not.toContain('customfield_')

      // One warning per site, however many pages the board asks for.
      await listBoardIssues(request)
      expect(
        warn.mock.calls.filter(([message]) => String(message).includes('role fields'))
      ).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })

  it("asks for the site's story-points field so a board card can show it", async () => {
    const record = issueRecord()
    mockBoardIssueReads(
      {
        startAt: 0,
        maxResults: 50,
        total: 1,
        isLast: true,
        issues: [{ ...record, fields: { ...record.fields, customfield_3: 5 } }]
      },
      [
        ...ROLE_FIELD_CATALOG,
        // The float custom field a site names "Story points", as the catalog reports it.
        {
          id: 'customfield_3',
          name: 'Story Points',
          schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float' }
        }
      ]
    )
    const { listBoardIssues } = await import('./jira-board-queries')

    const page = await listBoardIssues({ boardId: '42', siteId: 'site-1', scope: 'backlog' })

    // One catalog read answers both the role fields and the planning ones.
    expect(fieldCatalogCallCount()).toBe(1)
    const requested = new URL(boardIssueCallUrl(), 'https://example.invalid')
    expect(requested.searchParams.get('fields')?.split(',')).toContain('customfield_3')
    expect(page.issues[0]?.storyPoints).toBe(5)
    expect(page.issues[0]?.storyPointsFieldId).toBe('customfield_3')
  })

  it('uses offset pagination for self-hosted Jira backlogs', async () => {
    getClientsMock.mockReturnValue([makeServerEntry()])
    mockBoardIssueReads({
      startAt: 100,
      maxResults: 25,
      total: 125,
      issues: [issueRecord()]
    })
    const { listBoardIssues } = await import('./jira-board-queries')

    await expect(
      listBoardIssues({
        boardId: '42',
        siteId: 'server-1',
        scope: 'backlog',
        startAt: 100,
        maxResults: 25
      })
    ).resolves.toMatchObject({ startAt: 100, isLast: false, nextPageToken: null })
    expect(boardIssueCallUrl()).toContain('/rest/agile/1.0/board/42/backlog?')
    expect(boardIssueCallUrl()).toContain('startAt=100')
  })

  it('reads current-sprint pages without crossing site scope', async () => {
    mockBoardIssueReads({
      startAt: 100,
      maxResults: 100,
      isLast: false,
      nextPageToken: 'next-sprint-page',
      issues: [issueRecord()]
    })
    const { listBoardIssues } = await import('./jira-board-queries')

    await expect(
      listBoardIssues({
        boardId: '42',
        siteId: 'site-1',
        scope: 'sprint',
        sprintId: '87',
        pageToken: 'previous-sprint-page',
        startAt: 100
      })
    ).resolves.toMatchObject({
      startAt: 100,
      nextPageToken: 'next-sprint-page',
      isLast: false,
      issues: [{ key: 'ABC-1' }]
    })
    expect(boardIssueCallUrl()).toContain('/rest/software/1.0/board/42/sprint/87/issue?')
    expect(boardIssueCallUrl()).toContain('nextPageToken=previous-sprint-page')
    expect(getClientsMock).toHaveBeenCalledWith('site-1')
  })

  it('uses board-scoped offset pagination for self-hosted sprint issues', async () => {
    getClientsMock.mockReturnValue([makeServerEntry()])
    mockBoardIssueReads({
      startAt: 50,
      maxResults: 50,
      total: 100,
      isLast: false,
      issues: [issueRecord()]
    })
    const { listBoardIssues } = await import('./jira-board-queries')

    await listBoardIssues({
      boardId: '42',
      siteId: 'server-1',
      scope: 'sprint',
      sprintId: '87',
      startAt: 50,
      maxResults: 50
    })

    const url = boardIssueCallUrl()
    expect(url).toContain('/rest/agile/1.0/board/42/sprint/87/issue?')
    expect(url).toContain('startAt=50')
    expect(getClientsMock).toHaveBeenCalledWith('server-1')
  })
})
