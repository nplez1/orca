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
  jiraRequest: (...args: unknown[]) => jiraRequestMock(...args),
  JiraApiError: class JiraApiError extends Error {
    status: number | null
    constructor(message: string, status: number | null = null) {
      super(message)
      this.status = status
    }
  }
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

describe('Jira transition queries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthErrorMock.mockReturnValue(false)
    getClientsMock.mockReturnValue([makeEntry()])
    acquireMock.mockResolvedValue(undefined)
    releaseMock.mockImplementation(() => {})
    jiraRequestMock.mockReset()
  })

  it("asks Jira for each transition's screen fields and reports the required ones", async () => {
    jiraRequestMock.mockResolvedValue({
      transitions: [
        {
          id: '31',
          name: 'Done',
          to: { id: '3', name: 'Done', statusCategory: { key: 'done', name: 'Done' } },
          fields: {
            resolution: {
              required: true,
              name: 'Resolution',
              schema: { type: 'resolution' },
              allowedValues: [{ id: '10000', name: 'Fixed' }]
            },
            summary: { required: false, name: 'Summary', schema: { type: 'string' } }
          }
        }
      ]
    })
    const { listTransitions } = await import('./issues')

    const transitions = await listTransitions('ALP-1', 'site-1')

    expect(transitions[0].requiredFields?.map((field) => field.key)).toEqual(['resolution'])
    expect(transitions[0].requiredFields?.[0].name).toBe('Resolution')
    // Without the expand Jira reports no fields and the drop can only be attempted.
    const [, path] = jiraRequestMock.mock.calls[0]
    expect(path).toBe('/rest/api/3/issue/ALP-1/transitions?expand=transitions.fields')
  })

  it('omits requiredFields when the transition screen asks for nothing', async () => {
    jiraRequestMock.mockResolvedValue({
      transitions: [
        {
          id: '31',
          name: 'Done',
          to: { id: '3', name: 'Done', statusCategory: { key: 'done', name: 'Done' } },
          fields: { summary: { required: false, name: 'Summary', schema: { type: 'string' } } }
        }
      ]
    })
    const { listTransitions } = await import('./issues')

    const [transition] = await listTransitions('ALP-1', 'site-1')

    expect(transition.requiredFields).toBeUndefined()
  })
})
