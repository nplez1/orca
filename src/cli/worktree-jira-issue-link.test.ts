import { describe, expect, it } from 'vitest'
import type { JiraIssue, JiraSite } from '../shared/jira-types'
import { isWorkspaceLinkedItemSourceContextMatch } from '../shared/workspace-linked-item-source-context'
import type { JiraLinkRpcClient } from './handlers/worktree-jira-issue-link'
import {
  getJiraIssueLinkFlagUpdates,
  resolveJiraIssueLinkUpdates
} from './handlers/worktree-jira-issue-link'

const ACME: JiraSite = {
  id: 'site-1',
  siteUrl: 'https://acme.atlassian.net',
  email: 'me@acme.io',
  displayName: 'Acme',
  accountId: 'acc-1'
}
const OTHER: JiraSite = {
  id: 'site-2',
  siteUrl: 'https://other.atlassian.net',
  email: 'me@other.io',
  displayName: 'Other',
  accountId: 'acc-2'
}

function issue(key: string, siteId = 'site-1', siteUrl = ACME.siteUrl): JiraIssue {
  return {
    id: '1001',
    key,
    siteId,
    title: 'Fix checkout',
    url: `${siteUrl}/browse/${key}`,
    project: { id: 'p1', key: key.slice(0, key.lastIndexOf('-')), name: 'Payments' },
    issueType: { id: 'story', name: 'Story' },
    status: {
      id: '2',
      name: 'In Progress',
      categoryKey: 'indeterminate',
      categoryName: 'In Progress'
    },
    labels: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z'
  }
}

/** A client that answers the reads this module makes, by method name. */
function client(answers: {
  sites: JiraSite[]
  selectedSiteId?: string | null
  issue?: JiraIssue | null
  hostId?: string | null
  lookupThrows?: boolean
}): JiraLinkRpcClient & { calls: [string, unknown][] } {
  const calls: [string, unknown][] = []
  const respond = (method: string): unknown => {
    if (method === 'jira.status') {
      return {
        connected: answers.sites.length > 0,
        viewer: null,
        sites: answers.sites,
        selectedSiteId: answers.selectedSiteId ?? null
      }
    }
    if (method === 'jira.lookupIssueSummary') {
      if (answers.lookupThrows) {
        throw new Error('jira is down')
      }
      return answers.issue ?? null
    }
    if (method === 'worktree.show') {
      return { worktree: { hostId: answers.hostId ?? null } }
    }
    throw new Error(`unexpected method ${method}`)
  }
  return {
    calls,
    call: async <TResult>(method: string, params?: unknown): Promise<{ result: TResult }> => {
      calls.push([method, params])
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a dynamic test double answers by method name, and each test asserts the payload it reads.
      return { result: respond(method) as TResult }
    }
  }
}

describe('resolveJiraIssueLinkUpdates', () => {
  it('clears the link for an explicit null', async () => {
    const rpc = client({ sites: [ACME] })

    expect(
      await resolveJiraIssueLinkUpdates({ value: null, client: rpc, hostId: 'local' })
    ).toEqual({ linkedWorkItem: null, linkedTaskSourceContext: null })
    expect(rpc.calls).toEqual([])
  })

  it('rejects a value that names no Jira issue', async () => {
    const rpc = client({ sites: [ACME] })

    await expect(
      resolveJiraIssueLinkUpdates({ value: 'not an issue', client: rpc, hostId: 'local' })
    ).rejects.toThrow(/Pass a Jira issue key/)
  })

  it('rejects a bare key while nothing is connected', async () => {
    const rpc = client({ sites: [] })

    await expect(
      resolveJiraIssueLinkUpdates({ value: 'ABC-1', client: rpc, hostId: 'local' })
    ).rejects.toThrow(/Connect Jira/)
  })

  it('rejects a URL whose site is not connected to this host', async () => {
    const rpc = client({ sites: [ACME] })

    await expect(
      resolveJiraIssueLinkUpdates({
        value: 'https://other.atlassian.net/browse/ABC-1',
        client: rpc,
        hostId: 'local'
      })
    ).rejects.toThrow(/not connected to this host/)
  })

  it('refuses to guess between two accounts on one site', async () => {
    const rpc = client({ sites: [ACME, { ...ACME, id: 'site-1b' }] })

    await expect(
      resolveJiraIssueLinkUpdates({
        value: 'https://acme.atlassian.net/browse/ABC-1',
        client: rpc,
        hostId: 'local'
      })
    ).rejects.toThrow(/More than one connected Jira account/)
  })

  it('requires the full URL when the connected sites make a bare key ambiguous', async () => {
    const rpc = client({ sites: [ACME, OTHER] })

    await expect(
      resolveJiraIssueLinkUpdates({ value: 'ABC-1', client: rpc, hostId: 'local' })
    ).rejects.toThrow(/Pass the full Jira issue URL/)
  })

  it('reads a bare key from the selected site', async () => {
    const rpc = client({
      sites: [ACME, OTHER],
      selectedSiteId: 'site-2',
      issue: issue('ABC-1', 'site-2', OTHER.siteUrl)
    })

    const updates = await resolveJiraIssueLinkUpdates({
      value: 'ABC-1',
      client: rpc,
      hostId: 'local'
    })

    expect(rpc.calls).toContainEqual([
      'jira.lookupIssueSummary',
      { key: 'ABC-1', siteId: 'site-2' }
    ])
    expect(updates.linkedTaskSourceContext?.providerIdentity).toEqual({
      provider: 'jira',
      siteId: 'site-2',
      siteUrl: 'https://other.atlassian.net',
      projectKey: 'ABC'
    })
  })

  it('stores a pair the host accepts, on the workspace host', async () => {
    const rpc = client({ sites: [ACME], issue: issue('ABC-1') })

    const updates = await resolveJiraIssueLinkUpdates({
      value: 'ABC-1',
      client: rpc,
      hostId: 'ssh:build-box'
    })

    expect(updates.linkedWorkItem).toEqual({
      provider: 'jira',
      type: 'issue',
      number: 0,
      title: 'Fix checkout',
      url: 'https://acme.atlassian.net/browse/ABC-1',
      jiraIdentifier: 'ABC-1'
    })
    expect(updates.linkedTaskSourceContext?.hostId).toBe('ssh:build-box')
    // Why: the host drops a context whose identity disagrees with the item, so the
    // pair this writes has to satisfy the predicate the host applies on load.
    expect(
      updates.linkedWorkItem !== null &&
        updates.linkedTaskSourceContext !== null &&
        isWorkspaceLinkedItemSourceContextMatch(
          updates.linkedWorkItem,
          updates.linkedTaskSourceContext
        )
    ).toBe(true)
  })

  it('reports an issue this host does not have', async () => {
    const rpc = client({ sites: [ACME], issue: null })

    await expect(
      resolveJiraIssueLinkUpdates({ value: 'ABC-404', client: rpc, hostId: 'local' })
    ).rejects.toThrow(/Couldn't find ABC-404/)
  })

  it('reports a read that threw as not found rather than a transport error', async () => {
    const rpc = client({ sites: [ACME], lookupThrows: true })

    await expect(
      resolveJiraIssueLinkUpdates({ value: 'ABC-1', client: rpc, hostId: 'local' })
    ).rejects.toThrow(/Couldn't find ABC-1/)
  })

  it('rejects an issue the lookup returned under another key', async () => {
    const rpc = client({ sites: [ACME], issue: issue('XYZ-2') })

    await expect(
      resolveJiraIssueLinkUpdates({ value: 'ABC-1', client: rpc, hostId: 'local' })
    ).rejects.toThrow(/Couldn't find ABC-1/)
  })
})

describe('getJiraIssueLinkFlagUpdates', () => {
  it('does nothing without the flag, and does not read the workspace', async () => {
    const rpc = client({ sites: [ACME] })

    expect(
      await getJiraIssueLinkFlagUpdates({ flags: new Map(), client: rpc, worktree: 'active' })
    ).toBeUndefined()
    expect(rpc.calls).toEqual([])
  })

  it('takes the link host from the workspace it is linking', async () => {
    const rpc = client({ sites: [ACME], issue: issue('ABC-1'), hostId: 'ssh:build-box' })

    const updates = await getJiraIssueLinkFlagUpdates({
      flags: new Map([['jira-issue', 'ABC-1']]),
      client: rpc,
      worktree: 'active'
    })

    expect(rpc.calls[0]).toEqual(['worktree.show', { worktree: 'active' }])
    expect(updates?.linkedTaskSourceContext?.hostId).toBe('ssh:build-box')
  })

  it('clears on an explicit null without reading the workspace', async () => {
    const rpc = client({ sites: [ACME] })

    expect(
      await getJiraIssueLinkFlagUpdates({
        flags: new Map([['jira-issue', 'null']]),
        client: rpc,
        worktree: 'active'
      })
    ).toEqual({ linkedWorkItem: null, linkedTaskSourceContext: null })
    expect(rpc.calls).toEqual([])
  })

  it('rejects an empty flag value as a mistyped argument', async () => {
    const rpc = client({ sites: [ACME] })

    await expect(
      getJiraIssueLinkFlagUpdates({
        flags: new Map([['jira-issue', '   ']]),
        client: rpc,
        worktree: 'active'
      })
    ).rejects.toThrow(/Pass a Jira issue key/)
  })
})
