import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from './authenticated-request'
import type { JiraCreateField } from '../../shared/jira-types'

const { clearTokenMock, isAuthErrorMock, jiraRequestMock } = vi.hoisted(() => ({
  clearTokenMock: vi.fn(),
  isAuthErrorMock: vi.fn(),
  jiraRequestMock: vi.fn()
}))

vi.mock('./authenticated-request', () => ({
  apiBasePath: (site: { authType?: string }) =>
    site.authType === 'server' ? '/rest/api/2' : '/rest/api/3',
  jiraRequest: (...args: unknown[]) => jiraRequestMock(...args)
}))

vi.mock('./client', () => ({
  clearToken: (...args: unknown[]) => clearTokenMock(...args),
  isAuthError: (...args: unknown[]) => isAuthErrorMock(...args)
}))

vi.mock('./request-queue', () => ({ acquire: vi.fn(), release: vi.fn() }))

const entry: JiraClientForSite = {
  site: {
    id: 'site-1',
    siteUrl: 'https://example.atlassian.net',
    email: 'ada@example.com',
    displayName: 'Example Jira',
    accountId: 'account-1'
  },
  authorization: 'Basic token'
}

function field(overrides: Partial<JiraCreateField> = {}): JiraCreateField {
  return { key: 'customfield_1', name: 'Field', required: false, ...overrides }
}

const COMPONENTS = field({
  key: 'components',
  name: 'Component/s',
  schema: { type: 'array', items: 'string', system: 'components' }
})
const VERSIONS = field({
  key: 'versions',
  name: 'Affects Version/s',
  schema: { type: 'array', items: 'string', system: 'versions' }
})
const FIX_VERSIONS = field({
  key: 'fixVersions',
  name: 'Fix Version/s',
  schema: { type: 'array', items: 'string', system: 'fixVersions' }
})
const LABELS = field({ key: 'labels', schema: { type: 'array', items: 'string' } })

const COMPONENT_RECORDS = [
  { id: '10400', name: 'Web', description: 'Web client' },
  { id: '10401', name: 'Platform' }
]
const VERSION_RECORDS = [
  { id: '10100', name: '1.0', released: true },
  // No id: Jira would reject a reference to it, so it is not offered.
  { name: 'nameless' }
]

describe('projectKeyOfIssueKey', () => {
  it('splits the project off an issue key', async () => {
    const { projectKeyOfIssueKey } = await import('./jira-project-field-options')
    expect(projectKeyOfIssueKey('APP-1')).toBe('APP')
    expect(projectKeyOfIssueKey('AB_C-1234')).toBe('AB_C')
    // A key with no number keeps itself rather than becoming empty.
    expect(projectKeyOfIssueKey('APP')).toBe('APP')
  })
})

describe('readProjectFieldOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthErrorMock.mockReturnValue(false)
    jiraRequestMock.mockImplementation(async (_entry, path: string) => {
      if (path.endsWith('/components')) {
        return COMPONENT_RECORDS
      }
      if (path.endsWith('/versions')) {
        return VERSION_RECORDS
      }
      return null
    })
  })

  it('reads the project lists the fields need and nothing else', async () => {
    const { readProjectFieldOptions } = await import('./jira-project-field-options')

    const options = await readProjectFieldOptions(entry, 'APP', [COMPONENTS])

    expect(options).toEqual({
      components: [
        { id: '10400', name: 'Web' },
        { id: '10401', name: 'Platform' }
      ]
    })
    expect(jiraRequestMock.mock.calls.map((call) => call[1])).toEqual([
      '/rest/api/3/project/APP/components'
    ])
  })

  it('reads one project version list for both version fields', async () => {
    const { readProjectFieldOptions } = await import('./jira-project-field-options')

    const options = await readProjectFieldOptions(entry, 'APP', [VERSIONS, FIX_VERSIONS])

    expect(options.versions).toEqual([{ id: '10100', name: '1.0' }])
    expect(jiraRequestMock.mock.calls.map((call) => call[1])).toEqual([
      '/rest/api/3/project/APP/versions'
    ])
  })

  it('reads nothing when no field holds references', async () => {
    const { readProjectFieldOptions } = await import('./jira-project-field-options')

    expect(await readProjectFieldOptions(entry, 'APP', [LABELS, field()])).toEqual({})
    expect(jiraRequestMock).not.toHaveBeenCalled()
  })

  it('reads nothing for a field Jira already lists values for', async () => {
    // A site that supplies allowedValues scopes them to the screen the field came from.
    const { readProjectFieldOptions } = await import('./jira-project-field-options')

    const listed = { ...COMPONENTS, allowedValues: [{ id: '10400', name: 'Web' }] }
    expect(await readProjectFieldOptions(entry, 'APP', [listed])).toEqual({})
    expect(jiraRequestMock).not.toHaveBeenCalled()
  })

  it('leaves a kind out when its read fails, rather than failing the metadata', async () => {
    jiraRequestMock.mockRejectedValue(new Error('boom'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { readProjectFieldOptions } = await import('./jira-project-field-options')

    expect(await readProjectFieldOptions(entry, 'APP', [COMPONENTS, VERSIONS])).toEqual({})
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('does not treat an unreadable payload as a component list', async () => {
    jiraRequestMock.mockResolvedValue({ values: COMPONENT_RECORDS })
    const { readProjectFieldOptions } = await import('./jira-project-field-options')

    expect(await readProjectFieldOptions(entry, 'APP', [COMPONENTS])).toEqual({})
  })

  it('clears the token and rethrows an auth failure', async () => {
    const authError = new Error('401')
    jiraRequestMock.mockRejectedValue(authError)
    isAuthErrorMock.mockReturnValue(true)
    const { readProjectFieldOptions } = await import('./jira-project-field-options')

    await expect(readProjectFieldOptions(entry, 'APP', [COMPONENTS])).rejects.toThrow('401')
    expect(clearTokenMock).toHaveBeenCalledWith('site-1')
  })

  it('encodes a project key that came from an issue key', async () => {
    const { readProjectFieldOptions } = await import('./jira-project-field-options')

    await readProjectFieldOptions(entry, 'APP/X', [COMPONENTS])

    expect(jiraRequestMock.mock.calls[0]?.[1]).toBe('/rest/api/3/project/APP%2FX/components')
  })
})

describe('withJiraProjectFieldOptions', () => {
  it('attaches the list to the field that needs it and leaves the rest alone', async () => {
    const { withJiraProjectFieldOptions } = await import('./jira-project-field-options')
    const options = { components: [{ id: '10400', name: 'Web' }] }

    expect(withJiraProjectFieldOptions(COMPONENTS, options).allowedValues).toEqual([
      { id: '10400', name: 'Web' }
    ])
    // A string list whose kind was not read keeps whatever it had.
    expect(withJiraProjectFieldOptions(LABELS, options)).toBe(LABELS)
    expect(withJiraProjectFieldOptions(VERSIONS, options).allowedValues).toBeUndefined()
  })

  it("keeps the values Jira listed rather than replacing them with the project's", async () => {
    const { withJiraProjectFieldOptions } = await import('./jira-project-field-options')
    const listed = { ...COMPONENTS, allowedValues: [{ id: '9', name: 'Scoped' }] }

    expect(
      withJiraProjectFieldOptions(listed, { components: [{ id: '10400', name: 'Web' }] })
        .allowedValues
    ).toEqual([{ id: '9', name: 'Scoped' }])
  })
})
