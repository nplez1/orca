import { describe, expect, it } from 'vitest'

import {
  buildJiraIssueWorkspaceAttachmentIndex,
  findJiraIssueWorkspaceAttachment,
  findJiraIssueWorkspaceAttachmentInIndex,
  normalizeJiraIssueKey
} from './jira-issue-workspace-attachment'
import { getWorkspaceAttachments } from '../../../shared/workspace-attachments'
import type { JiraIssue } from '../../../shared/jira-types'
import type { Worktree } from '../../../shared/worktree/types'

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

function issue(key: string, site = 'https://acme.atlassian.net'): Pick<JiraIssue, 'key' | 'url'> {
  return { key, url: `${site}/browse/${key}` }
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
    expect(findJiraIssueWorkspaceAttachmentInIndex(index, { key: '' })).toBeNull()
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
})
