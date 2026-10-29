import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from './authenticated-request'
import type { JiraCreateField } from '../../shared/jira/jira-types'
import { _resetTracerForTests, setActiveSink, type TracerSink } from '../observability/tracer'

function captureSpans(): unknown[] {
  const records: unknown[] = []
  const sink: TracerSink = {
    push: (record) => records.push(record),
    flush() {},
    close() {}
  }
  setActiveSink(sink)
  return records
}

// Why afterEach: a failing assertion must not leave this suite's capturing sink installed.
afterEach(() => {
  _resetTracerForTests()
})

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
  // Why dropped: Jira's own picker hides archived versions and refuses to set one.
  { id: '10101', name: '0.9-legacy', archived: true },
  // No id: Jira would reject a reference to it, so it is not offered.
  { name: 'nameless' }
]

describe('readIssueProjectKey', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthErrorMock.mockReturnValue(false)
  })

  it('asks Jira which project the issue is in', async () => {
    // Why not the key's prefix: a moved issue keeps answering to its old key, and a
    // numeric id would be read as a project id.
    jiraRequestMock.mockResolvedValue({ fields: { project: { key: 'NEW', name: 'New home' } } })
    const { readIssueProjectKey } = await import('./jira-project-field-options')

    expect(await readIssueProjectKey(entry, 'APP-1')).toBe('NEW')
    expect(jiraRequestMock.mock.calls[0]?.[1]).toBe('/rest/api/3/issue/APP-1?fields=project')
  })

  it('returns an empty key when the read fails, rather than guessing one', async () => {
    jiraRequestMock.mockRejectedValue(new Error('boom'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const spans = captureSpans()
    const { readIssueProjectKey } = await import('./jira-project-field-options')

    expect(await readIssueProjectKey(entry, 'APP-1')).toBe('')
    // Why: returning '' is the whole problem the sink exists for — support cannot see a failure
    // that only reached a console nobody collects.
    expect(spans).toEqual([
      expect.objectContaining({
        name: 'swallowed-failure',
        attributes: { subsystem: 'jira', detail: 'issue project read failed' }
      })
    ])
    warn.mockRestore()
  })

  it('returns an empty key when the response carries no project', async () => {
    jiraRequestMock.mockResolvedValue({ fields: {} })
    const { readIssueProjectKey } = await import('./jira-project-field-options')

    expect(await readIssueProjectKey(entry, 'APP-1')).toBe('')
  })

  it('clears the token and rethrows an auth failure', async () => {
    jiraRequestMock.mockRejectedValue(new Error('401'))
    isAuthErrorMock.mockReturnValue(true)
    const { readIssueProjectKey } = await import('./jira-project-field-options')

    await expect(readIssueProjectKey(entry, 'APP-1')).rejects.toThrow('401')
    expect(clearTokenMock).toHaveBeenCalledWith('site-1')
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

    // The archived and the id-less entries are gone; the released one stays assignable.
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

describe('needsProjectFieldOptions', () => {
  it('asks for a list only for a reference field Jira listed no values for', async () => {
    const { needsProjectFieldOptions } = await import('./jira-project-field-options')

    expect(needsProjectFieldOptions(COMPONENTS)).toBe(true)
    expect(
      needsProjectFieldOptions({ ...COMPONENTS, allowedValues: [{ id: '10400', name: 'Web' }] })
    ).toBe(false)
    expect(needsProjectFieldOptions(LABELS)).toBe(false)
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
