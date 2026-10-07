// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraIssue, JiraSite } from '../../../../shared/jira-types'
import { isWorkspaceLinkedItemSourceContextMatch } from '../../../../shared/workspace-linked-item-source-context'
import { useResolveWorktreeMetaJiraLink } from './use-worktree-meta-jira-link'

const mocks = vi.hoisted(() => {
  const state: {
    jiraStatus: { connected: boolean; sites: JiraSite[]; selectedSiteId: string | null }
    settings: null
  } = {
    jiraStatus: { connected: true, sites: [], selectedSiteId: null },
    settings: null
  }
  return { lookupJiraIssueSummary: vi.fn(), state }
})

vi.mock('@/store', () => ({
  // Why the spread: the hook reads `lookupJiraIssueSummary` as a store action, and
  // the spy itself is what the test asserts on.
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ ...mocks.state, lookupJiraIssueSummary: mocks.lookupJiraIssueSummary })
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback?: string, values?: Record<string, string>) =>
    fallback && values ? `${fallback} ${JSON.stringify(values)}` : (fallback ?? _key)
}))

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

function resolveFor(worktree: Parameters<typeof useResolveWorktreeMetaJiraLink>[0]['worktree']) {
  const { result } = renderHook(() => useResolveWorktreeMetaJiraLink({ worktree }))
  return result.current
}

beforeEach(() => {
  mocks.lookupJiraIssueSummary.mockReset()
  mocks.state.jiraStatus = { connected: true, sites: [ACME], selectedSiteId: null }
  mocks.state.settings = null
})

describe('useResolveWorktreeMetaJiraLink', () => {
  it('resolves a typed URL against the site it names', async () => {
    mocks.state.jiraStatus.sites = [ACME, OTHER]
    mocks.state.jiraStatus.selectedSiteId = 'site-2'
    mocks.lookupJiraIssueSummary.mockResolvedValue(issue('ABC-1'))

    const resolution = await resolveFor({ hostId: 'local', linkedTaskSourceContext: null })({
      key: 'ABC-1',
      siteUrl: 'https://acme.atlassian.net'
    })

    expect(resolution.ok).toBe(true)
    if (!resolution.ok) {
      return
    }
    // The URL wins over the site selected in Settings — it is what the user typed.
    expect(mocks.lookupJiraIssueSummary.mock.calls[0]?.[2]).toBe('site-1')
    expect(resolution.link.linkedTaskSourceContext.providerIdentity).toEqual({
      provider: 'jira',
      siteId: 'site-1',
      siteUrl: 'https://acme.atlassian.net',
      projectKey: 'ABC'
    })
  })

  // The host drops a context whose identity disagrees with the item, so the pair
  // this writes has to satisfy the same predicate the host applies on load.
  it('produces an item and context the host accepts', async () => {
    mocks.lookupJiraIssueSummary.mockResolvedValue(issue('ABC-1'))

    const resolution = await resolveFor({ hostId: 'local', linkedTaskSourceContext: null })({
      key: 'ABC-1',
      siteUrl: 'https://acme.atlassian.net'
    })

    expect(resolution.ok).toBe(true)
    if (!resolution.ok) {
      return
    }
    expect(
      isWorkspaceLinkedItemSourceContextMatch(
        resolution.link.linkedWorkItem,
        resolution.link.linkedTaskSourceContext
      )
    ).toBe(true)
  })

  it('keeps a remote workspace pointed at its own host', async () => {
    mocks.lookupJiraIssueSummary.mockResolvedValue(issue('ABC-1'))

    const resolution = await resolveFor({
      hostId: 'ssh:build-box',
      linkedTaskSourceContext: null
    })({ key: 'ABC-1', siteUrl: 'https://acme.atlassian.net' })

    expect(resolution.ok && resolution.link.linkedTaskSourceContext.hostId).toBe('ssh:build-box')
  })

  // Why: a key alone is byte-identical to a Linear identifier and says nothing
  // about the site, so the only sites it may use are ones the user already chose.
  it('resolves a bare key from the only connected site', async () => {
    mocks.lookupJiraIssueSummary.mockResolvedValue(issue('ABC-1'))

    const resolution = await resolveFor({ hostId: 'local', linkedTaskSourceContext: null })({
      key: 'ABC-1',
      siteUrl: null
    })

    expect(resolution.ok).toBe(true)
    expect(mocks.lookupJiraIssueSummary.mock.calls[0]?.[2]).toBe('site-1')
  })

  it('prefers the site the workspace already reads from', async () => {
    mocks.state.jiraStatus.sites = [ACME, OTHER]
    mocks.state.jiraStatus.selectedSiteId = 'site-1'
    mocks.lookupJiraIssueSummary.mockResolvedValue(issue('ABC-1', 'site-2', OTHER.siteUrl))

    const resolution = await resolveFor({
      hostId: 'local',
      linkedTaskSourceContext: {
        kind: 'task-source',
        provider: 'jira',
        projectId: 'account-backed-task-source',
        hostId: 'local',
        providerIdentity: { provider: 'jira', siteId: 'site-2' }
      }
    })({ key: 'ABC-1', siteUrl: null })

    expect(resolution.ok).toBe(true)
    expect(mocks.lookupJiraIssueSummary.mock.calls[0]?.[2]).toBe('site-2')
  })

  it('refuses a bare key when the connected sites make it ambiguous', async () => {
    mocks.state.jiraStatus.sites = [ACME, OTHER]

    const resolution = await resolveFor({ hostId: 'local', linkedTaskSourceContext: null })({
      key: 'ABC-1',
      siteUrl: null
    })

    expect(resolution.ok).toBe(false)
    expect(mocks.lookupJiraIssueSummary).not.toHaveBeenCalled()
  })

  it('refuses a URL whose site is not connected', async () => {
    const resolution = await resolveFor({ hostId: 'local', linkedTaskSourceContext: null })({
      key: 'ABC-1',
      siteUrl: 'https://other.atlassian.net'
    })

    expect(resolution.ok).toBe(false)
    expect(mocks.lookupJiraIssueSummary).not.toHaveBeenCalled()
  })

  it('reports an issue the site does not have', async () => {
    mocks.lookupJiraIssueSummary.mockResolvedValue(null)

    const resolution = await resolveFor({ hostId: 'local', linkedTaskSourceContext: null })({
      key: 'ABC-404',
      siteUrl: 'https://acme.atlassian.net'
    })

    expect(resolution.ok).toBe(false)
  })

  it('reports a read that threw', async () => {
    mocks.lookupJiraIssueSummary.mockRejectedValue(new Error('jira is down'))

    const resolution = await resolveFor({ hostId: 'local', linkedTaskSourceContext: null })({
      key: 'ABC-1',
      siteUrl: 'https://acme.atlassian.net'
    })

    expect(resolution.ok).toBe(false)
  })

  it('refuses when no site is connected at all', async () => {
    mocks.state.jiraStatus.sites = []

    const resolution = await resolveFor({ hostId: 'local', linkedTaskSourceContext: null })({
      key: 'ABC-1',
      siteUrl: null
    })

    expect(resolution.ok).toBe(false)
  })

  // Why: resolving the key against a different site would move a live link to an
  // issue the user never named.
  it('refuses a bare key when the linked site is no longer connected', async () => {
    const resolution = await resolveFor({
      hostId: 'local',
      linkedTaskSourceContext: {
        kind: 'task-source',
        provider: 'jira',
        projectId: 'account-backed-task-source',
        hostId: 'local',
        providerIdentity: { provider: 'jira', siteId: 'site-gone' }
      }
    })({ key: 'ABC-1', siteUrl: null })

    expect(resolution.ok).toBe(false)
    expect(mocks.lookupJiraIssueSummary).not.toHaveBeenCalled()
  })

  // Two accounts can sit on one Jira host; only the site the workspace already
  // uses may break the tie, never the first match.
  it('refuses an ambiguous site shared by two accounts', async () => {
    mocks.state.jiraStatus.sites = [ACME, { ...ACME, id: 'site-1b', accountId: 'acc-1b' }]

    const resolution = await resolveFor({ hostId: 'local', linkedTaskSourceContext: null })({
      key: 'ABC-1',
      siteUrl: 'https://acme.atlassian.net'
    })

    expect(resolution.ok).toBe(false)
    expect(mocks.lookupJiraIssueSummary).not.toHaveBeenCalled()
  })

  it('breaks a shared-site tie with the site the workspace already uses', async () => {
    mocks.state.jiraStatus.sites = [ACME, { ...ACME, id: 'site-1b', accountId: 'acc-1b' }]
    mocks.lookupJiraIssueSummary.mockResolvedValue(issue('ABC-1', 'site-1b'))

    const resolution = await resolveFor({
      hostId: 'local',
      linkedTaskSourceContext: {
        kind: 'task-source',
        provider: 'jira',
        projectId: 'account-backed-task-source',
        hostId: 'local',
        providerIdentity: { provider: 'jira', siteId: 'site-1b' }
      }
    })({ key: 'ABC-1', siteUrl: 'https://acme.atlassian.net' })

    expect(resolution.ok).toBe(true)
    expect(mocks.lookupJiraIssueSummary.mock.calls[0]?.[2]).toBe('site-1b')
  })

  // A moved or reused key comes back as another issue; writing that pair would
  // leave the host keeping the item and dropping its routing context.
  it('refuses an issue the lookup returned under another key', async () => {
    mocks.lookupJiraIssueSummary.mockResolvedValue(issue('XYZ-2'))

    const resolution = await resolveFor({ hostId: 'local', linkedTaskSourceContext: null })({
      key: 'ABC-1',
      siteUrl: 'https://acme.atlassian.net'
    })

    expect(resolution.ok).toBe(false)
  })

  // Key and site can both match while the canonical URL names another issue; the
  // host rejects that pair, so it must not be written.
  it('refuses an issue whose canonical URL names another key', async () => {
    mocks.lookupJiraIssueSummary.mockResolvedValue({
      ...issue('ABC-1'),
      url: 'https://acme.atlassian.net/browse/ABC-2'
    })

    const resolution = await resolveFor({ hostId: 'local', linkedTaskSourceContext: null })({
      key: 'ABC-1',
      siteUrl: 'https://acme.atlassian.net'
    })

    expect(resolution.ok).toBe(false)
  })

  it('refuses an issue whose canonical URL lives on another site', async () => {
    mocks.lookupJiraIssueSummary.mockResolvedValue(
      issue('ABC-1', 'site-1', 'https://elsewhere.atlassian.net')
    )

    const resolution = await resolveFor({ hostId: 'local', linkedTaskSourceContext: null })({
      key: 'ABC-1',
      siteUrl: 'https://acme.atlassian.net'
    })

    expect(resolution.ok).toBe(false)
  })
})
