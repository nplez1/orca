import { describe, expect, it } from 'vitest'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'

import type { JiraIssue, JiraSite } from '../../../shared/jira-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { getWorkspaceAttachments } from '../../../shared/workspace-attachments'
import {
  buildJiraIssueWorkspaceAttachmentIndex,
  collectLinkedJiraIssueRefs,
  findJiraIssueWorkspaceAttachment,
  findJiraIssueWorkspaceAttachmentForIssue,
  findJiraIssueWorkspaceAttachmentInIndex,
  findJiraIssueWorkspaceAttachmentsInIndex,
  normalizeJiraIssueKey
} from './jira-issue-workspace-attachment'

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: overrides.id ?? 'wt-1',
    repoId: 'repo-1',
    path: overrides.path ?? '/tmp/repo-1/wt-1',
    head: 'abc123',
    branch: overrides.branch ?? 'refs/heads/feature/jira-attachment',
    isBare: false,
    isMainWorktree: false,
    displayName: overrides.displayName ?? 'Jira workspace',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function attached(
  key: string,
  overrides: Partial<Worktree> = {},
  site = 'https://acme.atlassian.net'
): Worktree {
  return worktree({
    linkedWorkItem: {
      provider: 'jira',
      type: 'issue',
      number: 0,
      title: key,
      url: `${site}/browse/${key}`,
      jiraIdentifier: key
    },
    ...overrides
  })
}

function issue(key: string, site = 'https://acme.atlassian.net'): JiraIssue {
  return {
    id: key,
    key,
    siteId: 'site-acme',
    title: key,
    url: `${site}/browse/${key}`,
    project: { id: 'project-acme', key: 'ACME', name: 'Acme' },
    issueType: { id: 'task', name: 'Task' },
    status: { id: '1', name: 'Open', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    createdAt: '',
    updatedAt: ''
  }
}

/** A link written the way the composer writes it: issue key and site identity both stored. */
function storedSite(key: string, url: string, siteUrl: string, siteId: string): Worktree {
  return worktree({
    linkedItems: [
      {
        provider: 'jira',
        type: 'issue',
        number: 0,
        title: key,
        url,
        jiraIdentifier: key,
        taskSourceContext: {
          kind: 'task-source',
          provider: 'jira',
          projectId: 'project-1',
          hostId: 'local',
          providerIdentity: {
            provider: 'jira',
            siteId,
            siteUrl,
            projectKey: key.slice(0, key.lastIndexOf('-'))
          }
        }
      }
    ]
  })
}

describe('Jira issue workspace attachment', () => {
  it('normalizes an issue key for comparison', () => {
    expect(normalizeJiraIssueKey(' alp-1 ')).toBe('ALP-1')
    expect(normalizeJiraIssueKey('')).toBeNull()
    expect(normalizeJiraIssueKey(undefined)).toBeNull()
  })

  it('finds the workspace linked to the issue key', () => {
    const linked = attached('ALP-1')

    expect(
      findJiraIssueWorkspaceAttachment([worktree({ id: 'other' }), linked], issue('ALP-1'))
    ).toBe(linked)
  })

  it('matches the key case-insensitively in both directions', () => {
    const lowerStored = attached('alp-1')

    expect(findJiraIssueWorkspaceAttachment([lowerStored], issue('ALP-1'))).toBe(lowerStored)
    expect(findJiraIssueWorkspaceAttachment([attached('ALP-1')], issue('alp-1'))).toBeTruthy()
  })

  it('ignores an attachment from another provider', () => {
    const linear = worktree({
      linkedWorkItem: {
        provider: 'linear',
        type: 'issue',
        number: 0,
        title: 'ALP-1',
        url: 'https://linear.app/acme/issue/ALP-1/title',
        linearIdentifier: 'ALP-1'
      }
    })

    expect(findJiraIssueWorkspaceAttachment([linear], issue('ALP-1'))).toBeNull()
  })

  it('ignores a workspace linked to a different key', () => {
    expect(findJiraIssueWorkspaceAttachment([attached('ALP-2')], issue('ALP-1'))).toBeNull()
  })

  it('returns null for a blank issue key', () => {
    expect(findJiraIssueWorkspaceAttachment([attached('ALP-1')], { key: '   ' })).toBeNull()
  })

  it('reads an attachment stored in the modern linkedItems list', () => {
    const modern = worktree({
      linkedItems: [
        {
          provider: 'jira',
          type: 'issue',
          number: 0,
          title: 'ALP-1',
          url: 'https://acme.atlassian.net/browse/ALP-1',
          jiraIdentifier: 'ALP-1'
        }
      ]
    })

    expect(findJiraIssueWorkspaceAttachment([modern], issue('ALP-1'))).toBe(modern)
  })

  it('prefers the workspace whose stored link names the same Jira site', () => {
    // Same key on two sites: the key alone cannot tell them apart.
    const otherSite = attached(
      'ALP-1',
      { id: 'other-site', lastActivityAt: 500 },
      'https://other.atlassian.net'
    )
    const sameSite = attached('ALP-1', { id: 'same-site', lastActivityAt: 10 })

    expect(findJiraIssueWorkspaceAttachment([otherSite, sameSite], issue('ALP-1'))).toBe(sameSite)
  })

  it('does not fall back to a workspace linked on a different Jira site', () => {
    const otherSite = attached('ALP-1', {}, 'https://other.atlassian.net')

    expect(findJiraIssueWorkspaceAttachment([otherSite], issue('ALP-1'))).toBeNull()
  })

  it('still matches when one side names no site', () => {
    const silent = worktree({
      linkedItems: [
        { provider: 'jira', type: 'issue', number: 0, title: 'ALP-1', jiraIdentifier: 'ALP-1' }
      ]
    })

    expect(findJiraIssueWorkspaceAttachment([silent], issue('ALP-1'))).toBe(silent)
  })

  it('prefers the most recently active workspace when several are equally specific', () => {
    const older = attached('ALP-1', { id: 'older', lastActivityAt: 10 })
    const newer = attached('ALP-1', { id: 'newer', lastActivityAt: 20 })

    expect(findJiraIssueWorkspaceAttachment([older, newer], issue('ALP-1'))).toBe(newer)
    expect(findJiraIssueWorkspaceAttachment([newer, older], issue('ALP-1'))).toBe(newer)
  })

  it('skips archived and removing workspaces', () => {
    const archived = attached('ALP-1', { id: 'archived', isArchived: true })
    const removing = attached('ALP-1', { id: 'removing', removing: true })

    expect(findJiraIssueWorkspaceAttachment([archived, removing], issue('ALP-1'))).toBeNull()
  })

  it('indexes every linked key and agrees with the linear scan', () => {
    const first = attached('ALP-1')
    const second = attached('BRV-2')
    const archived = attached('ALP-1', { id: 'archived', isArchived: true })
    const index = buildJiraIssueWorkspaceAttachmentIndex([first, second, archived, worktree()])

    expect(index.get('ALP-1')).toEqual([first])
    expect(index.get('BRV-2')).toEqual([second])
    expect(findJiraIssueWorkspaceAttachmentInIndex(index, issue('ALP-1'))).toBe(first)
    expect(findJiraIssueWorkspaceAttachmentInIndex(index, issue('BRV-2'))).toBe(second)
    expect(findJiraIssueWorkspaceAttachmentInIndex(index, issue('ALP-9'))).toBeNull()
    expect(findJiraIssueWorkspaceAttachmentInIndex(index, issue(''))).toBeNull()
  })

  it('applies the same site rule through the index', () => {
    const otherSite = attached('ALP-1', { id: 'other-site' }, 'https://other.atlassian.net')
    const sameSite = attached('ALP-1', { id: 'same-site' })
    const index = buildJiraIssueWorkspaceAttachmentIndex([otherSite, sameSite])

    expect(findJiraIssueWorkspaceAttachmentInIndex(index, issue('ALP-1'))).toBe(sameSite)
    expect(
      findJiraIssueWorkspaceAttachmentInIndex(index, issue('ALP-1', 'https://third.atlassian.net'))
    ).toBeNull()
  })

  it('matches on the link even when the stored identity came from another account', () => {
    // The stored id is sha256(site URL + account email), so signing in with another
    // account changes it while the site stays the same. The finder deliberately reads
    // the link's site, not that id (see jiraSiteScore), so a stored identity can never
    // refuse a link that names this issue's site.
    const reRegistered = storedSite(
      'ALP-1',
      'https://acme.atlassian.net/browse/ALP-1',
      'https://acme.atlassian.net',
      'site-from-another-account'
    )
    // Guard the fixture: without the stored context this would pass on the URL alone.
    expect(getWorkspaceAttachments(reRegistered)[0]?.taskSourceContext).toBeTruthy()

    expect(
      findJiraIssueWorkspaceAttachment([reRegistered], {
        key: 'ALP-1',
        url: 'https://acme.atlassian.net/browse/ALP-1'
      })
    ).toBe(reRegistered)
  })

  it('matches an issue that names no site at all', () => {
    const linked = attached('ALP-1')

    expect(findJiraIssueWorkspaceAttachment([linked], { key: 'ALP-1' })).toBe(linked)
  })

  it('prefers site evidence over a more recently active workspace without any', () => {
    const noEvidence = worktree({
      id: 'no-evidence',
      lastActivityAt: 500,
      linkedItems: [
        { provider: 'jira', type: 'issue', number: 0, title: 'ALP-1', jiraIdentifier: 'ALP-1' }
      ]
    })
    const sameSite = attached('ALP-1', { id: 'same-site', lastActivityAt: 10 })

    expect(findJiraIssueWorkspaceAttachment([noEvidence, sameSite], issue('ALP-1'))).toBe(sameSite)
  })

  it('keeps list order when site evidence and activity tie', () => {
    const first = attached('ALP-1', { id: 'first' })
    const second = attached('ALP-1', { id: 'second' })

    expect(findJiraIssueWorkspaceAttachment([first, second], issue('ALP-1'))).toBe(first)
    expect(findJiraIssueWorkspaceAttachment([second, first], issue('ALP-1'))).toBe(second)
  })

  it('keeps a removing workspace out of the index', () => {
    const index = buildJiraIssueWorkspaceAttachmentIndex([attached('ALP-1', { removing: true })])

    expect(index.size).toBe(0)
    expect(findJiraIssueWorkspaceAttachmentInIndex(index, issue('ALP-1'))).toBeNull()
  })

  it('resolves strict-first, then falls back to the permissive URL-identity finder', () => {
    // A link that records no site has no strict identity, so only the fork's
    // permissive finder can resolve it — and the shared rule must still reach it.
    const silent = worktree({
      linkedItems: [
        { provider: 'jira', type: 'issue', number: 0, title: 'ALP-1', jiraIdentifier: 'ALP-1' }
      ]
    })
    expect(findJiraIssueWorkspaceAttachmentForIssue([silent], issue('ALP-1'))).toBe(silent)

    // A same-site link wins over a no-site link when both are present, because the
    // strict match is tried first.
    const sameSite = attached('ALP-1', { id: 'same-site' })
    expect(findJiraIssueWorkspaceAttachmentForIssue([silent, sameSite], issue('ALP-1'))).toBe(
      sameSite
    )
  })
})

const site: JiraSite = {
  id: 'site-a',
  siteUrl: 'https://jira.example/jira',
  email: '',
  displayName: 'Acme',
  accountId: 'user'
}
const source: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'project-a',
  hostId: 'local',
  accountLabel: 'Acme',
  providerIdentity: { provider: 'jira', siteId: 'site-a', siteUrl: site.siteUrl, projectKey: 'APP' }
}
const linkedIssue: JiraIssue = {
  id: '1',
  key: 'APP-1',
  siteId: 'site-a',
  title: 'Fix',
  url: `${site.siteUrl}/browse/APP-1`,
  project: { id: '1', key: 'APP', name: 'App' },
  issueType: { id: '1', name: 'Bug' },
  status: { id: '1', name: 'Open', categoryKey: 'new', categoryName: 'Open' },
  labels: [],
  createdAt: '',
  updatedAt: ''
}
function linked(id: string, overrides: Partial<Worktree> = {}) {
  return makeWorktree({
    id,
    repoId: 'repo',
    linkedItems: [
      {
        provider: 'jira',
        type: 'issue',
        number: 0,
        identifier: 'app-1',
        url: linkedIssue.url,
        taskSourceContext: source
      }
    ],
    ...overrides
  })
}
function matches(
  workspaces: ReturnType<typeof makeWorktree>[],
  target = linkedIssue,
  context = source
) {
  return findJiraIssueWorkspaceAttachmentsInIndex(
    buildJiraIssueWorkspaceAttachmentIndex(workspaces),
    target,
    context
  )
}
describe('Jira workspace attachment identity', () => {
  it('finds every workspace across repositories and puts recent activity first', () => {
    const first = linked('api', { repoId: 'api', lastActivityAt: 1 })
    const second = linked('web', { repoId: 'web', lastActivityAt: 2 })
    expect(matches([first, second])).toEqual([second, first])
  })
  it('reads secondary attachments, not only the selected legacy link', () => {
    const workspace = linked('secondary')
    workspace.linkedWorkItem = {
      provider: 'github',
      type: 'issue',
      number: 42,
      title: 'Selected',
      url: 'https://github.com/acme/api/issues/42'
    }
    expect(matches([workspace])).toEqual([workspace])
  })
  it('includes folder and SSH workspaces when their Jira source is the desktop', () => {
    const folder = linked('folder:docs', { repoId: '', branch: '', hostId: 'ssh:builder' })
    expect(matches([folder])).toEqual([folder])
  })
  it('excludes archived workspaces and deduplicates attachment keys in a workspace', () => {
    const workspace = linked('live')
    workspace.linkedItems?.push({
      provider: 'jira',
      type: 'issue',
      number: 0,
      jiraIdentifier: 'APP-1',
      url: linkedIssue.url
    })
    expect(matches([linked('archived', { isArchived: true }), workspace])).toEqual([workspace])
  })
  it('rejects identifier collisions on another site, context path, or project', () => {
    const workspace = linked('same-key')
    expect(
      matches([workspace], {
        ...linkedIssue,
        siteId: 'site-b',
        url: 'https://other.example/browse/APP-1'
      })
    ).toEqual([])
    expect(
      matches([workspace], { ...linkedIssue, url: 'https://jira.example/other/browse/APP-1' })
    ).toEqual([])
    expect(
      matches([workspace], {
        ...linkedIssue,
        project: { ...linkedIssue.project, key: 'OTHER' }
      })
    ).toEqual([])
  })
  it('rejects another execution host or Jira account but allows other repo contexts', () => {
    const workspace = linked('same-key')
    expect(matches([workspace], linkedIssue, { ...source, hostId: 'runtime:cloud' })).toEqual([])
    expect(matches([workspace], linkedIssue, { ...source, accountLabel: 'another' })).toEqual([])
    expect(
      matches([workspace], linkedIssue, {
        ...source,
        projectId: 'other-repo-project',
        repoId: 'other'
      })
    ).toEqual([workspace])
  })
  it('requires proven site identity for old key-only links', () => {
    const bare = makeWorktree({
      id: 'bare',
      repoId: 'repo',
      linkedItems: [{ provider: 'jira', type: 'issue', number: 0, jiraIdentifier: 'APP-1' }]
    })
    expect(matches([bare])).toEqual([])
    const legacy = makeWorktree({
      id: 'legacy',
      repoId: 'repo',
      linkedWorkItem: {
        provider: 'jira',
        type: 'issue',
        number: 0,
        jiraIdentifier: 'APP-1',
        title: 'Fix',
        url: linkedIssue.url
      }
    })
    expect(matches([legacy])).toEqual([legacy])
  })
  it('matches account-scoped links in the all-sites view', () => {
    expect(matches([linked('one')], linkedIssue, { ...source, accountLabel: null })).toHaveLength(1)
  })

  it('collects each linked issue once, respects selected site and drops foreign sources', () => {
    const refs = collectLinkedJiraIssueRefs(
      [linked('one'), linked('two'), linked('archived', { isArchived: true })],
      [site],
      'all',
      source
    )
    expect(refs).toMatchObject([{ key: 'APP-1', siteId: site.id, sourceContext: source }])
    expect(collectLinkedJiraIssueRefs([linked('one')], [site], 'site-b', source)).toEqual([])
    expect(
      collectLinkedJiraIssueRefs([linked('one')], [site], 'all', {
        ...source,
        hostId: 'runtime:cloud'
      })
    ).toEqual([])
  })
})
