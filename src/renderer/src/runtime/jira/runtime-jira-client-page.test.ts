// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { jiraSearchIssuesPageForTarget } from './runtime-jira-client'

const { callRuntimeRpcMock } = vi.hoisted(() => ({ callRuntimeRpcMock: vi.fn() }))
vi.mock('../rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpcMock(...args)
}))

const target = { kind: 'environment' as const, environmentId: 'remote' }

function missingMethod(): Error {
  return Object.assign(new Error('method_not_found'), { code: 'method_not_found' })
}

function issueRecord(key: string) {
  return {
    id: key,
    key,
    siteId: 'site-1',
    title: `${key} title`,
    url: `https://example.atlassian.net/browse/${key}`,
    project: { id: 'project-1', key: 'ABC', name: 'Payments' },
    issueType: { id: 'story', name: 'Story' },
    status: { id: '1', name: 'Ready', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    assignee: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z'
  }
}

beforeEach(() => {
  callRuntimeRpcMock.mockReset()
})

describe('Jira page reads against a host without the page methods', () => {
  it('asks the array search for one row past the page size and reports truncation', async () => {
    callRuntimeRpcMock.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'jira.searchIssuesPage') {
        throw missingMethod()
      }
      return Array.from({ length: 51 }, (_, index) => issueRecord(`ABC-${index + 1}`))
    })

    const page = await jiraSearchIssuesPageForTarget(target, 'project = ABC', 50, 'site-1')

    expect(page.issues).toHaveLength(50)
    expect(page.hasMore).toBe(true)
    // Why no continuation: the array method cannot page, so there is nothing to resume.
    expect(page.continuation).toBeNull()
    expect(callRuntimeRpcMock).toHaveBeenLastCalledWith(
      target,
      'jira.searchIssues',
      expect.objectContaining({ limit: 51 }),
      expect.anything()
    )
  })

  it('claims no truncation when the probe comes back with exactly the page size', async () => {
    callRuntimeRpcMock.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'jira.searchIssuesPage') {
        throw missingMethod()
      }
      return Array.from({ length: 50 }, (_, index) => issueRecord(`ABC-${index + 1}`))
    })

    const page = await jiraSearchIssuesPageForTarget(target, 'project = ABC', 50, 'site-1')

    expect(page.hasMore).toBe(false)
    expect(page.issues).toHaveLength(50)
  })

  it('never probes with a cursor, which a host without the page methods cannot honour', async () => {
    callRuntimeRpcMock.mockRejectedValue(missingMethod())

    await expect(
      jiraSearchIssuesPageForTarget(target, 'project = ABC', 50, 'site-1', undefined, {
        pageToken: 'token-2',
        startAt: 0
      })
    ).rejects.toThrow('method_not_found')
    expect(callRuntimeRpcMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces a failure the page method reports for any other reason', async () => {
    callRuntimeRpcMock.mockRejectedValue(new Error('Jira is down'))

    await expect(
      jiraSearchIssuesPageForTarget(target, 'project = ABC', 50, 'site-1')
    ).rejects.toThrow('Jira is down')
    expect(callRuntimeRpcMock).toHaveBeenCalledTimes(1)
  })
})
