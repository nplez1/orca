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

function issueRecord(teamValue: unknown = undefined) {
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
      updated: '2026-09-02T00:00:00.000Z',
      customfield_10001: teamValue
    }
  }
}

describe('Jira board queries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthErrorMock.mockReturnValue(false)
    getClientsMock.mockReturnValue([makeEntry()])
    jiraRequestMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    releaseMock.mockImplementation(() => {})
  })

  it('lists accessible boards across every page and includes the Jira site identity', async () => {
    jiraRequestMock
      .mockResolvedValueOnce({
        startAt: 0,
        maxResults: 1,
        total: 2,
        isLast: false,
        values: [{ id: 42, name: 'Payments', type: 'scrum' }]
      })
      .mockResolvedValueOnce({
        startAt: 1,
        maxResults: 1,
        total: 2,
        isLast: true,
        values: [{ id: 43, name: 'Payments Archive', type: 'kanban' }]
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
      '/rest/agile/1.0/board?startAt=0&maxResults=50',
      '/rest/agile/1.0/board?startAt=1&maxResults=50'
    ])
  })

  it('lists custom fields with their schema types and omits standard fields', async () => {
    jiraRequestMock.mockResolvedValueOnce([
      { id: 'summary', name: 'Summary', custom: false },
      {
        id: 'customfield_10001',
        name: 'Delivery Team',
        custom: true,
        schema: { type: 'option', custom: 'select' }
      }
    ])
    const { listCustomFields } = await import('./jira-board-queries')

    await expect(listCustomFields('site-1')).resolves.toEqual([
      {
        id: 'customfield_10001',
        name: 'Delivery Team',
        schemaType: 'option',
        customType: 'select',
        siteId: 'site-1',
        siteName: 'Example Jira'
      }
    ])
    expect(jiraRequestMock.mock.calls[0]?.[1]).toBe('/rest/api/3/field')
  })

  it('loads board columns and only requests active sprints for Scrum boards', async () => {
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
            startDate: '2026-09-01T00:00:00.000Z'
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
          endDate: undefined
        }
      ]
    })
    expect(jiraRequestMock.mock.calls.map((call) => call[1])).toEqual([
      '/rest/agile/1.0/board/42',
      '/rest/agile/1.0/board/42/configuration',
      '/rest/agile/1.0/board/42/sprint?state=active&startAt=0&maxResults=50'
    ])
  })

  it('does not request sprints for Kanban boards', async () => {
    jiraRequestMock
      .mockResolvedValueOnce({ id: 44, name: 'Triage', type: 'kanban' })
      .mockResolvedValueOnce({ columnConfig: { columns: [] } })
    const { getBoardOverview } = await import('./jira-board-queries')

    await expect(getBoardOverview('44', 'site-1')).resolves.toMatchObject({
      board: { type: 'kanban' },
      activeSprints: []
    })
    expect(jiraRequestMock).toHaveBeenCalledTimes(2)
  })

  it('reads a board-filter backlog page and maps the configured team field', async () => {
    jiraRequestMock.mockResolvedValueOnce({
      startAt: 100,
      maxResults: 25,
      total: 130,
      isLast: false,
      nextPageToken: 'next-page',
      issues: [issueRecord({ id: 'team-1', name: 'Payments' })]
    })
    const { listBoardIssues } = await import('./jira-board-queries')

    await expect(
      listBoardIssues({
        boardId: '42',
        siteId: 'site-1',
        scope: 'backlog',
        teamFieldId: 'customfield_10001',
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
          status: { id: '3', name: 'In Progress' },
          teamValue: { key: 'team-1', label: 'Payments' }
        }
      ]
    })
    const url = String(jiraRequestMock.mock.calls[0]?.[1])
    expect(url).toContain('/rest/software/1.0/board/42/backlog?')
    expect(url).toContain('nextPageToken=previous-page')
    expect(url).toContain('maxResults=25')
    expect(url).toContain('customfield_10001')
  })

  it('uses offset pagination for self-hosted Jira backlogs', async () => {
    getClientsMock.mockReturnValue([makeServerEntry()])
    jiraRequestMock.mockResolvedValueOnce({
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
    expect(String(jiraRequestMock.mock.calls[0]?.[1])).toContain(
      '/rest/agile/1.0/board/42/backlog?'
    )
    expect(String(jiraRequestMock.mock.calls[0]?.[1])).toContain('startAt=100')
  })

  it('reads current-sprint pages without crossing site scope', async () => {
    jiraRequestMock.mockResolvedValueOnce({
      startAt: 100,
      maxResults: 100,
      isLast: false,
      nextPageToken: 'next-sprint-page',
      issues: [issueRecord('Payments')]
    })
    const { listBoardIssues } = await import('./jira-board-queries')

    await expect(
      listBoardIssues({
        boardId: '42',
        siteId: 'site-1',
        scope: 'sprint',
        sprintId: '87',
        teamFieldId: 'customfield_10001',
        pageToken: 'previous-sprint-page',
        startAt: 100
      })
    ).resolves.toMatchObject({
      startAt: 100,
      nextPageToken: 'next-sprint-page',
      isLast: false,
      issues: [{ teamValue: { key: 'Payments', label: 'Payments' } }]
    })
    expect(String(jiraRequestMock.mock.calls[0]?.[1])).toContain(
      '/rest/software/1.0/board/42/sprint/87/issue?'
    )
    expect(String(jiraRequestMock.mock.calls[0]?.[1])).toContain(
      'nextPageToken=previous-sprint-page'
    )
    expect(getClientsMock).toHaveBeenCalledWith('site-1')
  })

  it('uses board-scoped offset pagination for self-hosted sprint issues', async () => {
    getClientsMock.mockReturnValue([makeServerEntry()])
    jiraRequestMock.mockResolvedValueOnce({
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

    const url = String(jiraRequestMock.mock.calls[0]?.[1])
    expect(url).toContain('/rest/agile/1.0/board/42/sprint/87/issue?')
    expect(url).toContain('startAt=50')
    expect(getClientsMock).toHaveBeenCalledWith('server-1')
  })
})
