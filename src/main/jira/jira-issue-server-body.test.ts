import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from './authenticated-request'

const { clearTokenMock, getClientsMock, isAuthErrorMock, jiraRequestMock, jiraRequestBinaryMock } =
  vi.hoisted(() => ({
    clearTokenMock: vi.fn(),
    getClientsMock: vi.fn(),
    isAuthErrorMock: vi.fn(),
    jiraRequestMock: vi.fn(),
    jiraRequestBinaryMock: vi.fn()
  }))

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

vi.mock('./request-queue', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn()
}))

function makeServerEntry(): JiraClientForSite {
  return {
    site: {
      id: 'server-1',
      siteUrl: 'https://jira.example.com',
      email: '',
      displayName: 'Self-hosted Jira',
      accountId: 'wquintal',
      authType: 'server'
    },
    authorization: 'Bearer pat-token'
  }
}

/** Self-hosted Jira answers with wiki markup plus the HTML it rendered from it,
 *  and the body the app shows must be that HTML rather than the markup. */
describe('Jira issue bodies on a self-hosted site', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthErrorMock.mockReturnValue(false)
    getClientsMock.mockReturnValue([makeServerEntry()])
  })

  it('renders the description from Jira HTML instead of its wiki markup', async () => {
    const pngBytes = Uint8Array.from([137, 80, 78, 71])
    jiraRequestBinaryMock.mockResolvedValue({
      data: pngBytes.buffer,
      contentType: 'image/png'
    })
    jiraRequestMock.mockResolvedValue({
      id: 'issue-77',
      key: 'ALP-77',
      fields: {
        summary: 'Self-hosted wiki body',
        description: 'h3. Steps\n{code}\nnpm test\n{code}\nSee !shot.png!',
        attachment: [
          {
            id: '10001',
            filename: 'shot.png',
            mimeType: 'image/png',
            size: 4,
            content: '/secure/attachment/10001/shot.png'
          }
        ],
        project: { id: '1', key: 'ALP', name: 'ALP' },
        issuetype: { id: '1', name: 'Story' },
        status: { id: '1', name: 'To Do', statusCategory: { key: 'new', name: 'To Do' } },
        labels: [],
        created: '2026-06-18T00:00:00.000Z',
        updated: '2026-06-18T00:00:00.000Z'
      },
      renderedFields: {
        description:
          '<h3>Steps</h3><div class="code"><pre>npm test</pre></div>' +
          '<p>See <img src="/secure/attachment/10001/shot.png" alt="shot.png" /></p>' +
          '<p><a href="/browse/ALP-1">ALP-1</a></p>'
      }
    })

    const { getIssue } = await import('./issues')
    const issue = await getIssue('ALP-77', 'server-1')

    expect(issue?.description).toContain('<h3>Steps</h3>')
    expect(issue?.description).toContain('<pre>npm test</pre>')
    expect(issue?.description).not.toContain('{code}')
    // Why: a server body has no ADF media nodes, so its rendered `<img>` ids are
    // the only signal that an attachment needs downloading.
    expect(issue?.description).toContain('data:image/png;base64,')
    expect(issue?.description).toContain('https://jira.example.com/browse/ALP-1')
  })
})
