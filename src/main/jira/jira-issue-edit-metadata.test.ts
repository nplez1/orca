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

function makeEntry(authType?: 'cloud' | 'server'): JiraClientForSite {
  return {
    site: {
      id: 'site-1',
      siteUrl: 'https://example.atlassian.net',
      email: 'ada@example.com',
      displayName: 'Example Jira',
      accountId: 'account-1',
      ...(authType ? { authType } : {})
    },
    authorization: 'Basic token'
  }
}

describe('Jira issue edit metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthErrorMock.mockReturnValue(false)
    getClientsMock.mockReturnValue([makeEntry()])
    acquireMock.mockResolvedValue(undefined)
    releaseMock.mockImplementation(() => {})
    jiraRequestMock.mockReset()
  })

  it('reads editable custom fields with their current values, skipping what Orca cannot render', async () => {
    jiraRequestMock.mockResolvedValue({
      fields: {
        customfield_10001: { accountId: 'account-9', displayName: 'Dev Name' },
        customfield_10002: { id: '2', value: 'High' }
      },
      editmeta: {
        fields: {
          customfield_10001: {
            name: 'Dev',
            required: false,
            schema: { type: 'user' },
            operations: ['set']
          },
          customfield_10002: {
            name: 'Severity',
            required: false,
            schema: { type: 'option' },
            allowedValues: [{ id: '2', value: 'High' }],
            operations: ['set']
          },
          // No control submits a time-tracking object, so it must not be offered.
          customfield_10003: {
            name: 'Time tracking',
            required: false,
            schema: { type: 'timetracking' },
            operations: ['set']
          },
          // The row already edits the summary, so the form must not duplicate it.
          summary: {
            name: 'Summary',
            required: true,
            schema: { type: 'string' },
            operations: ['set']
          },
          // Remove-only fields cannot be written through a field edit.
          customfield_10004: {
            name: 'Locked',
            required: false,
            schema: { type: 'string' },
            operations: ['remove']
          }
        }
      }
    })
    const { listEditFields } = await import('./issues')

    const fields = await listEditFields('ALP-1', 'site-1')

    expect(fields.map((entry) => entry.field.key)).toEqual([
      'customfield_10001',
      'customfield_10002'
    ])
    expect(fields[0]).toMatchObject({ value: 'account-9', displayName: 'Dev Name' })
    expect(fields[1]).toMatchObject({ value: '2' })
    const [, path] = jiraRequestMock.mock.calls[0]
    expect(path).toBe('/rest/api/3/issue/ALP-1?expand=editmeta')
  })

  it('drafts a multi-select option field as the ids its control holds', async () => {
    jiraRequestMock.mockResolvedValue({
      fields: {
        customfield_10062: [
          { id: '184354', value: 'mac-intel' },
          { id: '184357', value: 'win-arm' }
        ]
      },
      editmeta: {
        fields: {
          customfield_10062: {
            name: 'System',
            required: false,
            schema: { type: 'array', items: 'option' },
            allowedValues: [
              { id: '184354', value: 'mac-intel' },
              { id: '184355', value: 'mar-arm' },
              { id: '184357', value: 'win-arm' }
            ],
            operations: ['set']
          }
        }
      }
    })
    const { listEditFields } = await import('./issues')

    const [field] = await listEditFields('ALP-1', 'site-1')

    // The control names these options itself, so no hint is built for it.
    expect(field).toEqual({
      field: expect.objectContaining({ key: 'customfield_10062' }),
      value: '184354, 184357'
    })
    expect(field.displayName).toBeUndefined()
  })

  it('drafts a string list from the entries themselves', async () => {
    jiraRequestMock.mockResolvedValue({
      fields: { customfield_10100: ['one', ' two '] },
      editmeta: {
        fields: {
          customfield_10100: {
            name: 'Notes',
            required: false,
            schema: { type: 'array', items: 'string' },
            operations: ['set']
          }
        }
      }
    })
    const { listEditFields } = await import('./issues')

    const [field] = await listEditFields('ALP-1', 'site-1')

    expect(field.value).toBe('one, two')
  })

  it('leaves an unset user field as an empty draft', async () => {
    jiraRequestMock.mockResolvedValue({
      fields: {},
      editmeta: {
        fields: {
          customfield_10001: {
            name: 'QE',
            required: false,
            schema: { type: 'user' },
            operations: ['set']
          }
        }
      }
    })
    const { listEditFields } = await import('./issues')

    const [field] = await listEditFields('ALP-1', 'site-1')

    expect(field).toMatchObject({ value: '' })
    expect(field.displayName).toBeUndefined()
  })

  it('returns nothing when no site is connected', async () => {
    getClientsMock.mockReturnValue([])
    const { listEditFields } = await import('./issues')

    expect(await listEditFields('ALP-1')).toEqual([])
    expect(jiraRequestMock).not.toHaveBeenCalled()
  })
})
