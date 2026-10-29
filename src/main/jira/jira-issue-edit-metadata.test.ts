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

    expect(field).toEqual({
      field: expect.objectContaining({ key: 'customfield_10062' }),
      value: '184354, 184357',
      // Kept for a renderer that predates the option list control and still shows the text
      // box; there the labels are the only readable form of the value.
      displayName: 'mac-intel, win-arm'
    })
  })

  it('drafts a multi-user field with the people it holds', async () => {
    jiraRequestMock.mockResolvedValue({
      fields: {
        customfield_10013: [
          { accountId: 'u-ada', displayName: 'Ada Lovelace' },
          { accountId: 'u-grace', displayName: 'Grace Hopper' }
        ]
      },
      editmeta: {
        fields: {
          customfield_10013: {
            name: 'QEs',
            required: false,
            schema: {
              type: 'array',
              items: 'user',
              custom: 'com.atlassian.jira.plugin.system.customfieldtypes:multiuserpicker'
            },
            operations: ['set']
          }
        }
      }
    })
    const { listEditFields } = await import('./issues')

    const [field] = await listEditFields('ALP-1', 'site-1')

    expect(field).toEqual({
      field: expect.objectContaining({ key: 'customfield_10013' }),
      value: 'u-ada, u-grace',
      // Kept for a renderer that predates `users` and still shows the text box.
      displayName: 'Ada Lovelace, Grace Hopper',
      users: [
        { accountId: 'u-ada', displayName: 'Ada Lovelace' },
        { accountId: 'u-grace', displayName: 'Grace Hopper' }
      ]
    })
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

  it('drafts a components field as the ids the project list matches', async () => {
    // The issue names Component/s directly: it is a system field, so it only reaches
    // this form now, and only as a reference the project's own list can resolve.
    jiraRequestMock.mockImplementation(async (_entry, path: string) => {
      if (path.endsWith('/components')) {
        return [
          { id: '10400', name: 'Web' },
          { id: '10401', name: 'Platform' }
        ]
      }
      return {
        fields: {
          project: { key: 'ALP', name: 'Alpha' },
          components: [{ id: '10401', name: 'Platform' }]
        },
        editmeta: {
          fields: {
            components: {
              name: 'Component/s',
              required: false,
              schema: { type: 'array', items: 'string', system: 'components' },
              operations: ['set', 'add', 'remove']
            },
            // A system field that holds strings, offered nowhere.
            labels: {
              name: 'Labels',
              required: false,
              schema: { type: 'array', items: 'string', system: 'labels' },
              operations: ['set']
            }
          }
        }
      }
    })
    const { listEditFields } = await import('./issues')

    const fields = await listEditFields('ALP-1', 'site-1')

    expect(fields.map((entry) => entry.field.key)).toEqual(['components'])
    expect(fields[0]?.field.allowedValues).toEqual([
      { id: '10400', name: 'Web' },
      { id: '10401', name: 'Platform' }
    ])
    expect(fields[0]).toMatchObject({ value: '10401', displayName: 'Platform' })
    // The project comes from the issue read, so no key guessing is needed.
    expect(jiraRequestMock.mock.calls[1]?.[1]).toBe('/rest/api/3/project/ALP/components')
  })

  it('offers a reference field whatever item type the site reports', async () => {
    // Sites report `items: string` or `items: version` for the same field, and the control
    // must not be decided by the item type.
    jiraRequestMock.mockImplementation(async (_entry, path: string) => {
      if (path.endsWith('/versions')) {
        return [{ id: '10100', name: '1.0' }]
      }
      return {
        fields: { project: { key: 'ALP' }, fixVersions: [{ id: '10100', name: '1.0' }] },
        editmeta: {
          fields: {
            fixVersions: {
              name: 'Fix Version/s',
              required: false,
              schema: { type: 'array', items: 'version', system: 'fixVersions' },
              operations: ['set']
            }
          }
        }
      }
    })
    const { listEditFields } = await import('./issues')

    const fields = await listEditFields('ALP-1', 'site-1')

    expect(fields.map((entry) => entry.field.key)).toEqual(['fixVersions'])
    expect(fields[0]?.field.allowedValues).toEqual([{ id: '10100', name: '1.0' }])
    expect(fields[0]?.value).toBe('10100')
    expect(jiraRequestMock.mock.calls[1]?.[1]).toBe('/rest/api/3/project/ALP/versions')
  })

  it('keeps the text box when the edit read names no project', async () => {
    // Why: without a project there is no list to read, and guessing one from the issue
    // key would offer another project's components to an issue that has moved.
    jiraRequestMock.mockResolvedValue({
      fields: { components: [{ id: '10401', name: 'Platform' }] },
      editmeta: {
        fields: {
          components: {
            name: 'Component/s',
            required: false,
            schema: { type: 'array', items: 'string', system: 'components' },
            operations: ['set']
          }
        }
      }
    })
    const { listEditFields } = await import('./issues')

    const [field] = await listEditFields('ALP-1', 'site-1')

    expect(field?.field.allowedValues).toBeUndefined()
    expect(field?.value).toBe('Platform')
    expect(jiraRequestMock).toHaveBeenCalledTimes(1)
  })

  it('returns nothing when no site is connected', async () => {
    getClientsMock.mockReturnValue([])
    const { listEditFields } = await import('./issues')

    expect(await listEditFields('ALP-1')).toEqual([])
    expect(jiraRequestMock).not.toHaveBeenCalled()
  })

  it('reports the failure to a caller that asked for it instead of an empty form', async () => {
    jiraRequestMock.mockRejectedValue(new Error('Jira returned 502'))
    const { listEditFields } = await import('./issues')

    await expect(listEditFields('ALP-1', 'site-1', true)).rejects.toThrow('Jira returned 502')
    // The default stays the resilient read the other surfaces rely on.
    await expect(listEditFields('ALP-1', 'site-1')).resolves.toEqual([])
  })
})
