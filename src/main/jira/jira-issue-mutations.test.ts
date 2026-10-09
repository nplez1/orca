import { beforeEach, describe, expect, it, vi } from 'vitest'
import { textToAdf } from './adf-markdown'
import type { JiraClientForSite } from './authenticated-request'

const {
  clearTokenMock,
  getClientsMock,
  isAuthErrorMock,
  jiraRequestMock,
  jiraRequestBinaryMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  clearTokenMock: vi.fn(),
  getClientsMock: vi.fn(),
  isAuthErrorMock: vi.fn(),
  jiraRequestMock: vi.fn(),
  jiraRequestBinaryMock: vi.fn(),
  acquireMock: vi.fn().mockResolvedValue(undefined),
  releaseMock: vi.fn()
}))

vi.mock('./request-queue', () => ({ acquire: acquireMock, release: releaseMock }))

vi.mock('./authenticated-request', () => ({
  apiBasePath: (site: { authType?: string }) =>
    site.authType === 'server' ? '/rest/api/2' : '/rest/api/3',
  jiraRequest: (...args: unknown[]) => jiraRequestMock(...args),
  jiraRequestBinary: (...args: unknown[]) => jiraRequestBinaryMock(...args),
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

function makeServerEntry(id = 'server-1'): JiraClientForSite {
  return {
    site: {
      id,
      siteUrl: 'https://jira.example.com',
      email: '',
      displayName: 'Self-hosted Jira',
      accountId: 'wquintal',
      authType: 'server'
    },
    authorization: 'Bearer pat-token'
  }
}

/** The JSON body of the first recorded request, read without an assertion. */
function readPostedJsonBody(call: unknown): unknown {
  if (!Array.isArray(call)) {
    throw new Error('expected a request argument tuple')
  }
  const init = call[2]
  if (typeof init !== 'object' || init === null || !('body' in init)) {
    throw new Error('expected a request body')
  }
  const { body } = init
  if (typeof body !== 'string') {
    throw new Error('expected a serialized request body')
  }
  return JSON.parse(body)
}

describe('Jira issue mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthErrorMock.mockReturnValue(false)
    getClientsMock.mockReturnValue([makeEntry()])
    acquireMock.mockResolvedValue(undefined)
    releaseMock.mockImplementation(() => {})
    jiraRequestMock.mockReset()
  })

  it('sends plain-text bodies and v2 paths for self-hosted issue creation', async () => {
    getClientsMock.mockReturnValue([makeServerEntry()])
    jiraRequestMock.mockResolvedValueOnce({ id: '1', key: 'ALP-1', self: '' })
    const { createIssue } = await import('./issues')

    await createIssue({
      siteId: 'server-1',
      projectId: '10000',
      issueTypeId: '10001',
      title: 'Fix auth',
      description: 'Body text'
    })

    const [, path, init] = jiraRequestMock.mock.calls[0]
    expect(path).toBe('/rest/api/2/issue')
    const body = JSON.parse((init as { body: string }).body) as {
      fields: { description: unknown }
    }
    // REST v2 rejects ADF documents; the description must stay a plain string.
    expect(body.fields.description).toBe('Body text')
  })

  // Only the composer's own Markdown is reinterpreted, so a body that merely looks
  // like Markdown reaches Jira exactly as typed — the regression this branch prevents.
  it('stores an unmarked comment body verbatim on a self-hosted site', async () => {
    getClientsMock.mockReturnValue([makeServerEntry()])
    jiraRequestMock.mockResolvedValueOnce({ id: 'comment-1' })
    const { addIssueComment } = await import('./issues')
    const pasted = '{code}\n- not a list\n{code}'

    await addIssueComment('ALP-1', pasted, 'server-1')

    expect(readPostedJsonBody(jiraRequestMock.mock.calls[0])).toEqual({ body: pasted })
  })

  it('stores an unmarked comment body as plain ADF text on Cloud', async () => {
    getClientsMock.mockReturnValue([makeEntry()])
    jiraRequestMock.mockResolvedValueOnce({ id: 'comment-1' })
    const { addIssueComment } = await import('./issues')

    await addIssueComment('ALP-1', '**bold**', 'site-1')

    expect(readPostedJsonBody(jiraRequestMock.mock.calls[0])).toEqual({
      body: textToAdf('**bold**')
    })
  })

  it('posts a self-hosted comment as wiki markup', async () => {
    getClientsMock.mockReturnValue([makeServerEntry()])
    jiraRequestMock.mockResolvedValueOnce({ id: 'comment-1' })
    const { addIssueComment } = await import('./issues')

    await addIssueComment('ALP-1', '**bold**', 'server-1', 'markdown')

    const [, path] = jiraRequestMock.mock.calls[0]
    expect(path).toBe('/rest/api/2/issue/ALP-1/comment')
    // The composer is Markdown; v2 renders wiki markup, so an unconverted body
    // would show its asterisks.
    expect(readPostedJsonBody(jiraRequestMock.mock.calls[0])).toEqual({ body: '{*}bold{*}' })
  })

  it('posts a Cloud comment as an ADF document', async () => {
    getClientsMock.mockReturnValue([makeEntry()])
    jiraRequestMock.mockResolvedValueOnce({ id: 'comment-1' })
    const { addIssueComment } = await import('./issues')

    await addIssueComment('ALP-1', '**bold**', 'site-1', 'markdown')

    const [, path] = jiraRequestMock.mock.calls[0]
    expect(path).toBe('/rest/api/3/issue/ALP-1/comment')
    expect(readPostedJsonBody(jiraRequestMock.mock.calls[0])).toEqual({
      body: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'bold', marks: [{ type: 'strong' }] }]
          }
        ]
      }
    })
  })

  it('shapes user-typed create fields into Jira user objects', async () => {
    getClientsMock.mockReturnValue([makeEntry()])
    jiraRequestMock.mockResolvedValueOnce({ id: '1', key: 'ALP-1', self: 'https://x' })
    const { createIssue } = await import('./issues')

    await createIssue({
      siteId: 'site-1',
      projectId: '10000',
      issueTypeId: '10001',
      title: 'Fix auth',
      customFields: { reporter: 'account-9', customfield_1: 'plain', customfield_2: ['a', 'b'] },
      userFieldKeys: ['reporter', 'customfield_2']
    })

    const [, , init] = jiraRequestMock.mock.calls[0]
    const body = JSON.parse((init as { body: string }).body) as { fields: Record<string, unknown> }
    // A bare string here is what Jira reports back as "Reporter is required".
    expect(body.fields.reporter).toEqual({ accountId: 'account-9' })
    expect(body.fields.customfield_2).toEqual([{ accountId: 'a' }, { accountId: 'b' }])
    expect(body.fields.customfield_1).toBe('plain')
  })

  it('shapes user-typed create fields by username on self-hosted sites', async () => {
    getClientsMock.mockReturnValue([makeServerEntry()])
    jiraRequestMock.mockResolvedValueOnce({ id: '1', key: 'ALP-1', self: 'https://x' })
    const { createIssue } = await import('./issues')

    await createIssue({
      siteId: 'server-1',
      projectId: '10000',
      issueTypeId: '10001',
      title: 'Fix auth',
      customFields: { reporter: 'wquintal' },
      userFieldKeys: ['reporter']
    })

    const [, , init] = jiraRequestMock.mock.calls[0]
    const body = JSON.parse((init as { body: string }).body) as { fields: Record<string, unknown> }
    expect(body.fields.reporter).toEqual({ name: 'wquintal' })
  })

  it('leaves create fields untouched when no user keys are declared', async () => {
    getClientsMock.mockReturnValue([makeEntry()])
    jiraRequestMock.mockResolvedValueOnce({ id: '1', key: 'ALP-1', self: 'https://x' })
    const { createIssue } = await import('./issues')

    await createIssue({
      siteId: 'site-1',
      projectId: '10000',
      issueTypeId: '10001',
      title: 'Fix auth',
      customFields: { customfield_1: { id: '3' } }
    })

    const [, , init] = jiraRequestMock.mock.calls[0]
    const body = JSON.parse((init as { body: string }).body) as { fields: Record<string, unknown> }
    expect(body.fields.customfield_1).toEqual({ id: '3' })
  })

  it('unassigns by username on self-hosted sites', async () => {
    getClientsMock.mockReturnValue([makeServerEntry()])
    jiraRequestMock.mockResolvedValue(null)
    const { updateIssue } = await import('./issues')

    await updateIssue('ALP-1', { assigneeAccountId: null }, 'server-1')

    expect(jiraRequestMock).toHaveBeenCalledWith(
      expect.anything(),
      '/rest/api/2/issue/ALP-1/assignee',
      expect.objectContaining({ body: JSON.stringify({ name: null }) })
    )
  })

  it('assigns by username on self-hosted sites', async () => {
    getClientsMock.mockReturnValue([makeServerEntry()])
    jiraRequestMock.mockResolvedValue(null)
    const { updateIssue } = await import('./issues')

    await updateIssue('ALP-1', { assigneeAccountId: 'wquintal' }, 'server-1')

    expect(jiraRequestMock).toHaveBeenCalledWith(
      expect.anything(),
      '/rest/api/2/issue/ALP-1/assignee',
      expect.objectContaining({ body: JSON.stringify({ name: 'wquintal' }) })
    )
  })
})
