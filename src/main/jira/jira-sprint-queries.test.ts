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

function makeEntry(id = 'site-1'): JiraClientForSite {
  return {
    site: {
      id,
      siteUrl: 'https://example.atlassian.net',
      email: 'ada@example.com',
      displayName: 'Example Jira',
      accountId: 'account-1'
    },
    authorization: 'Basic token'
  }
}

function sprint(id: number, name: string, state: string, extra: Record<string, unknown> = {}) {
  return { id, name, state, originBoardId: 42, ...extra }
}

beforeEach(() => {
  vi.resetModules()
  clearTokenMock.mockReset()
  getClientsMock.mockReset()
  isAuthErrorMock.mockReset().mockReturnValue(false)
  jiraRequestMock.mockReset()
  acquireMock.mockClear()
  releaseMock.mockClear()
  getClientsMock.mockReturnValue([makeEntry()])
})

describe('getIssueSprintAssignment', () => {
  it('reads the issue sprint and offers the board sprints that can receive it', async () => {
    jiraRequestMock
      .mockResolvedValueOnce({ fields: { sprint: sprint(87, 'September sprint', 'active') } })
      .mockResolvedValueOnce({
        values: [
          sprint(87, 'September sprint', 'active'),
          sprint(88, 'October sprint', 'future', { startDate: '2026-10-01T00:00:00.000Z' })
        ],
        isLast: true
      })
    const { getIssueSprintAssignment } = await import('./jira-sprint-queries')

    await expect(
      getIssueSprintAssignment({ key: 'ABC-1', siteId: 'site-1', boardId: '42' })
    ).resolves.toEqual({
      sprint: {
        id: '87',
        name: 'September sprint',
        state: 'active',
        startDate: undefined,
        endDate: undefined,
        boardId: '42'
      },
      sprints: [
        {
          id: '87',
          name: 'September sprint',
          state: 'active',
          startDate: undefined,
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
      '/rest/agile/1.0/issue/ABC-1',
      '/rest/agile/1.0/board/42/sprint?state=active%2Cfuture&startAt=0&maxResults=50'
    ])
    // A read that opened a pool slot must return it.
    expect(acquireMock).toHaveBeenCalledTimes(1)
    expect(releaseMock).toHaveBeenCalledTimes(1)
  })

  // Jira documents the sprint field as a single object and returns an array in
  // practice, so a mapper that only handled one shape would hide the assignment.
  it('reads a single-object sprint field', async () => {
    jiraRequestMock
      .mockResolvedValueOnce({ fields: { sprint: sprint(87, 'September sprint', 'active') } })
      .mockResolvedValueOnce({ values: [], isLast: true })
    const { getIssueSprintAssignment } = await import('./jira-sprint-queries')

    const assignment = await getIssueSprintAssignment({ key: 'ABC-1', siteId: 'site-1' })

    expect(assignment.sprint).toMatchObject({ id: '87', boardId: '42' })
    // No board hint and no sprint list: the issue's own board still gets listed.
    expect(jiraRequestMock.mock.calls[1][1]).toBe(
      '/rest/agile/1.0/board/42/sprint?state=active%2Cfuture&startAt=0&maxResults=50'
    )
    expect(assignment.sprints).toEqual([expect.objectContaining({ id: '87' })])
  })

  it('takes the last sprint when the field holds several', async () => {
    jiraRequestMock
      .mockResolvedValueOnce({
        fields: {
          sprint: [sprint(86, 'August sprint', 'closed'), sprint(87, 'September sprint', 'active')]
        }
      })
      .mockResolvedValueOnce({ values: [], isLast: true })
    const { getIssueSprintAssignment } = await import('./jira-sprint-queries')

    expect(
      (await getIssueSprintAssignment({ key: 'ABC-1', siteId: 'site-1' })).sprint
    ).toMatchObject({ id: '87' })
  })

  it('reports a backlog issue with no board in scope as having nothing to move into', async () => {
    jiraRequestMock.mockResolvedValueOnce({ fields: {} })
    const { getIssueSprintAssignment } = await import('./jira-sprint-queries')

    await expect(getIssueSprintAssignment({ key: 'ABC-2', siteId: 'site-1' })).resolves.toEqual({
      sprint: null,
      sprints: []
    })
    expect(jiraRequestMock).toHaveBeenCalledTimes(1)
  })

  it('lists both the board it was asked about and the sprint own board, without duplicates', async () => {
    jiraRequestMock
      .mockResolvedValueOnce({ fields: { sprint: sprint(90, 'Elsewhere sprint', 'active') } })
      .mockResolvedValueOnce({
        values: [sprint(87, 'September sprint', 'active')],
        isLast: true
      })
      .mockResolvedValueOnce({
        values: [
          sprint(90, 'Elsewhere sprint', 'active'),
          sprint(87, 'September sprint', 'active')
        ],
        isLast: true
      })
    const { getIssueSprintAssignment } = await import('./jira-sprint-queries')

    const assignment = await getIssueSprintAssignment({
      key: 'ABC-1',
      siteId: 'site-1',
      boardId: '77'
    })

    expect(jiraRequestMock.mock.calls[1][1]).toContain('/board/77/sprint?')
    expect(jiraRequestMock.mock.calls[2][1]).toContain('/board/42/sprint?')
    expect(assignment.sprints.map((entry) => entry.id).sort()).toEqual(['87', '90'])
  })

  it('keeps the current sprint pickable when the listed boards do not contain it', async () => {
    jiraRequestMock
      .mockResolvedValueOnce({ fields: { sprint: sprint(90, 'Elsewhere sprint', 'active') } })
      .mockResolvedValueOnce({ values: [sprint(87, 'September sprint', 'active')], isLast: true })
      .mockResolvedValueOnce({ values: [], isLast: true })
    const { getIssueSprintAssignment } = await import('./jira-sprint-queries')

    const assignment = await getIssueSprintAssignment({
      key: 'ABC-1',
      siteId: 'site-1',
      boardId: '77'
    })

    expect(assignment.sprint).toMatchObject({ id: '90' })
    expect(assignment.sprints.map((entry) => entry.id).sort()).toEqual(['87', '90'])
    expect(jiraRequestMock).toHaveBeenCalledTimes(3)
  })

  it('keeps the other board sprints when one board cannot list any', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      jiraRequestMock
        .mockResolvedValueOnce({ fields: { sprint: sprint(90, 'Elsewhere sprint', 'active') } })
        // Why: Jira answers 400 for a Kanban board's sprint list, and that board is a
        // legitimate default board — it must not hide the sprints of the board that can answer.
        .mockRejectedValueOnce(new Error('Board 77 does not support sprints'))
        .mockResolvedValueOnce({ values: [sprint(88, 'October sprint', 'future')], isLast: true })
      const { getIssueSprintAssignment } = await import('./jira-sprint-queries')

      const assignment = await getIssueSprintAssignment({
        key: 'ABC-1',
        siteId: 'site-1',
        boardId: '77'
      })

      expect(assignment.sprint).toMatchObject({ id: '90' })
      expect(assignment.sprints.map((entry) => entry.id)).toEqual(['90', '88'])
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('still fails the read when a board rejects the credentials', async () => {
    isAuthErrorMock.mockReturnValue(true)
    jiraRequestMock
      .mockResolvedValueOnce({ fields: {} })
      .mockRejectedValueOnce(new Error('Unauthorized'))
    const { getIssueSprintAssignment } = await import('./jira-sprint-queries')

    await expect(
      getIssueSprintAssignment({ key: 'ABC-1', siteId: 'site-1', boardId: '77' })
    ).rejects.toThrow('Unauthorized')
    expect(clearTokenMock).toHaveBeenCalledWith('site-1')
  })

  it('never offers a closed sprint, even when the board lists one', async () => {
    jiraRequestMock
      .mockResolvedValueOnce({ fields: { sprint: sprint(86, 'August sprint', 'closed') } })
      .mockResolvedValueOnce({
        values: [sprint(86, 'August sprint', 'closed'), sprint(88, 'October sprint', 'future')],
        isLast: true
      })
    const { getIssueSprintAssignment } = await import('./jira-sprint-queries')

    const assignment = await getIssueSprintAssignment({
      key: 'ABC-1',
      siteId: 'site-1',
      boardId: '42'
    })

    // The open sprint is the only target; the closed one survives only as the
    // issue's own position, which is what the picker shows as current.
    expect(assignment.sprints.map((entry) => entry.id)).toEqual(['88', '86'])
    expect(assignment.sprint).toMatchObject({ id: '86' })
    expect(assignment.sprints.find((entry) => entry.id === '86')?.state).toBe('closed')
    expect(assignment.sprints.find((entry) => entry.id === '88')?.state).toBe('future')
  })

  it('orders active sprints before future ones and then by start date', async () => {
    jiraRequestMock.mockResolvedValueOnce({ fields: {} }).mockResolvedValueOnce({
      values: [
        sprint(89, 'November sprint', 'future', { startDate: '2026-11-01T00:00:00.000Z' }),
        sprint(88, 'October sprint', 'future', { startDate: '2026-10-01T00:00:00.000Z' }),
        sprint(87, 'September sprint', 'active')
      ],
      isLast: true
    })
    const { getIssueSprintAssignment } = await import('./jira-sprint-queries')

    const assignment = await getIssueSprintAssignment({
      key: 'ABC-1',
      siteId: 'site-1',
      boardId: '42'
    })

    expect(assignment.sprints.map((entry) => entry.id)).toEqual(['87', '88', '89'])
  })

  it('clears the token when the site rejects the read', async () => {
    const unauthorized = new Error('Unauthorized')
    isAuthErrorMock.mockReturnValue(true)
    jiraRequestMock.mockRejectedValueOnce(unauthorized)
    const { getIssueSprintAssignment } = await import('./jira-sprint-queries')

    await expect(getIssueSprintAssignment({ key: 'ABC-1', siteId: 'site-1' })).rejects.toThrow(
      'Unauthorized'
    )
    expect(clearTokenMock).toHaveBeenCalledWith('site-1')
    expect(releaseMock).toHaveBeenCalledTimes(1)
  })

  it('requires exactly one connected site', async () => {
    getClientsMock.mockReturnValue([])
    const { getIssueSprintAssignment } = await import('./jira-sprint-queries')

    await expect(getIssueSprintAssignment({ key: 'ABC-1' })).rejects.toThrow(
      'A single Jira site is required for board data.'
    )
    expect(jiraRequestMock).not.toHaveBeenCalled()
  })
})
