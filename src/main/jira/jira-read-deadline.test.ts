import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from './authenticated-request'

const { fetchMock, proxyMock, getClientsMock, clearTokenMock, isAuthErrorMock } = vi.hoisted(
  () => ({
    fetchMock: vi.fn(),
    proxyMock: vi.fn(),
    getClientsMock: vi.fn(),
    clearTokenMock: vi.fn(),
    isAuthErrorMock: vi.fn()
  })
)

vi.mock('../network/http-client', () => ({
  getMainHttpClient: () => ({ fetch: fetchMock, proxySession: () => null })
}))
vi.mock('../network/proxy-settings', () => ({
  ensureElectronProxyFromEnvironment: (...args: unknown[]) => proxyMock(...args)
}))
vi.mock('../observability/tracer', () => ({
  withSpan: (
    _name: string,
    run: (span: { setAttribute: () => void; addEvent: () => void }) => Promise<unknown>
  ) => run({ setAttribute: () => {}, addEvent: () => {} })
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

/** A connection nobody answers, the way a VPN drop or a black-holed proxy behaves. */
function hungFetch(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = (): void =>
      reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))
    if (init?.signal?.aborted) {
      abort()
      return
    }
    init?.signal?.addEventListener('abort', abort, { once: true })
  })
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

async function flushMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 25; tick += 1) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  fetchMock.mockReset().mockImplementation(hungFetch)
  proxyMock.mockReset().mockResolvedValue(undefined)
  getClientsMock.mockReset().mockReturnValue([makeEntry()])
  clearTokenMock.mockReset()
  isAuthErrorMock.mockReset().mockReturnValue(false)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Jira read deadlines', () => {
  it('times out four hung board reads, frees their slots, and then serves a fifth', async () => {
    const { JIRA_REQUEST_TIMEOUT_MS } = await import('./jira-request-deadline')
    const { getBoardOverview } = await import('./jira-board-queries')

    const hung = Array.from({ length: 4 }, () => getBoardOverview('42', 'site-1'))
    // Attached before the deadline fires: an unawaited rejection reads as unhandled.
    const hungOutcomes = Promise.allSettled(hung)
    await flushMicrotasks()
    // Every one of the four global slots is now held by a connection that never answers.
    expect(fetchMock).toHaveBeenCalledTimes(4)

    const fifth = getBoardOverview('42', 'site-1').then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    )
    await flushMicrotasks()
    expect(fetchMock).toHaveBeenCalledTimes(4)

    // The fifth answers as soon as it is let through; the four never do.
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).pathname.endsWith('/configuration')
        ? jsonResponse({ columnConfig: { columns: [] } })
        : jsonResponse({ id: 42, name: 'Payments', type: 'kanban' })
    )
    await vi.advanceTimersByTimeAsync(JIRA_REQUEST_TIMEOUT_MS)

    const outcomes = await hungOutcomes
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'rejected',
      'rejected',
      'rejected',
      'rejected'
    ])
    for (const outcome of outcomes) {
      expect(outcome.status === 'rejected' && String(outcome.reason)).toContain(
        'did not answer in time'
      )
    }

    await expect(fifth).resolves.toMatchObject({ ok: true, value: { board: { id: '42' } } })
    // The four released slots are what let the queued read reach the network at all.
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it('times out a read that stalls before fetch is ever called', async () => {
    const { JIRA_REQUEST_TIMEOUT_MS, JIRA_REQUEST_TIMEOUT_MESSAGE } =
      await import('./jira-request-deadline')
    const { jiraRequest } = await import('./authenticated-request')
    // Why: the proxy probe runs before fetch, so a signal alone would never settle this.
    proxyMock.mockImplementation(() => new Promise(() => {}))

    const read = jiraRequest(makeEntry(), '/rest/api/3/myself')
    const outcome = expect(read).rejects.toThrow(JIRA_REQUEST_TIMEOUT_MESSAGE)
    await vi.advanceTimersByTimeAsync(JIRA_REQUEST_TIMEOUT_MS)
    await outcome
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('honours a caller signal rather than its own deadline', async () => {
    const { jiraRequest } = await import('./authenticated-request')
    const controller = new AbortController()

    const read = jiraRequest(makeEntry(), '/rest/api/3/myself', { signal: controller.signal })
    const outcome = expect(read).rejects.toThrow('aborted')
    controller.abort()
    await outcome
  })

  it('leaves a create unbounded so a blind retry cannot duplicate the issue', async () => {
    const { createIssue } = await import('./jira-issue-mutations')
    let settled = false

    const created = createIssue({
      siteId: 'site-1',
      projectId: 'project-1',
      issueTypeId: 'story',
      title: 'Move payments work'
    })
    void created.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await vi.advanceTimersByTimeAsync(120_000)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
  })
})
