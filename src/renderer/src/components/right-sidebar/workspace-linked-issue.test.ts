import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import { resolveIssuePaneLinkedIssue, resolveWorkspaceLinkedIssue } from './workspace-linked-issue'

type LinkedIssueSource = Pick<
  Worktree,
  | 'linkedIssue'
  | 'linkedLinearIssue'
  | 'linkedLinearIssueWorkspaceId'
  | 'linkedLinearIssueOrganizationUrlKey'
  | 'linkedGitLabIssue'
  | 'linkedWorkItem'
>

function source(overrides: Partial<LinkedIssueSource> = {}): LinkedIssueSource {
  return {
    linkedIssue: null,
    linkedLinearIssue: null,
    linkedLinearIssueWorkspaceId: null,
    linkedLinearIssueOrganizationUrlKey: null,
    linkedGitLabIssue: null,
    linkedWorkItem: null,
    ...overrides
  }
}

describe('resolveWorkspaceLinkedIssue', () => {
  it('returns null when nothing is linked', () => {
    expect(resolveWorkspaceLinkedIssue(source())).toBeNull()
  })

  it('reads a GitHub link from the dedicated slot', () => {
    expect(resolveWorkspaceLinkedIssue(source({ linkedIssue: 42 }))).toEqual({
      provider: 'github',
      number: 42,
      identifier: '#42',
      url: null,
      title: null
    })
  })

  it('reads a Linear link with its workspace and org context', () => {
    expect(
      resolveWorkspaceLinkedIssue(
        source({
          linkedLinearIssue: 'ENG-42',
          linkedLinearIssueWorkspaceId: 'ws-1',
          linkedLinearIssueOrganizationUrlKey: 'acme'
        })
      )
    ).toEqual({
      provider: 'linear',
      identifier: 'ENG-42',
      workspaceId: 'ws-1',
      organizationUrlKey: 'acme',
      url: null,
      title: null
    })
  })

  it('reads a Jira link from the linked work item', () => {
    expect(
      resolveWorkspaceLinkedIssue(
        source({
          linkedWorkItem: {
            provider: 'jira',
            type: 'issue',
            number: 123,
            title: 'Fix checkout',
            url: 'https://acme.atlassian.net/browse/PROJ-123',
            jiraIdentifier: 'PROJ-123'
          }
        })
      )
    ).toEqual({
      provider: 'jira',
      key: 'PROJ-123',
      identifier: 'PROJ-123',
      url: 'https://acme.atlassian.net/browse/PROJ-123',
      title: 'Fix checkout'
    })
  })

  it('falls back to the work-item number when a Jira item has no key', () => {
    const linked = resolveWorkspaceLinkedIssue(
      source({
        linkedWorkItem: {
          provider: 'jira',
          type: 'issue',
          number: 123,
          title: 'Fix checkout',
          url: 'https://acme.atlassian.net/browse/PROJ-123'
        }
      })
    )
    expect(linked?.provider === 'jira' && linked.identifier).toBe('123')
  })

  it('reads a GitHub work item when the dedicated slot is empty', () => {
    expect(
      resolveWorkspaceLinkedIssue(
        source({
          linkedWorkItem: {
            provider: 'github',
            type: 'issue',
            number: 7,
            title: 'Crash on launch',
            url: 'https://github.com/acme/orca/issues/7'
          }
        })
      )
    ).toEqual({
      provider: 'github',
      number: 7,
      identifier: '#7',
      url: 'https://github.com/acme/orca/issues/7',
      title: 'Crash on launch'
    })
  })

  it('ignores pull requests and merge requests', () => {
    expect(
      resolveWorkspaceLinkedIssue(
        source({
          linkedWorkItem: {
            provider: 'github',
            type: 'pr',
            number: 9,
            title: 'A PR',
            url: 'https://github.com/acme/orca/pull/9'
          }
        })
      )
    ).toBeNull()
  })

  it('reads a GitLab issue from the legacy slot or the work item', () => {
    expect(resolveWorkspaceLinkedIssue(source({ linkedGitLabIssue: 5 }))).toMatchObject({
      provider: 'gitlab',
      number: 5,
      identifier: '#5'
    })
    expect(
      resolveWorkspaceLinkedIssue(
        source({
          linkedWorkItem: {
            provider: 'gitlab',
            type: 'issue',
            number: 6,
            title: 'GitLab issue',
            url: 'https://gitlab.com/acme/orca/-/issues/6'
          }
        })
      )
    ).toMatchObject({ provider: 'gitlab', number: 6, title: 'GitLab issue' })
  })

  it('prefers a Jira work item over a legacy GitLab slot so the pane still renders', () => {
    const linked = resolveWorkspaceLinkedIssue(
      source({
        linkedGitLabIssue: 5,
        linkedWorkItem: {
          provider: 'jira',
          type: 'issue',
          number: 123,
          title: 'Fix checkout',
          url: 'https://acme.atlassian.net/browse/PROJ-123',
          jiraIdentifier: 'PROJ-123'
        }
      })
    )
    expect(linked?.provider).toBe('jira')
  })

  it('prefers an explicit GitHub slot over a Jira work item, matching the meta editor', () => {
    const linked = resolveWorkspaceLinkedIssue(
      source({
        linkedIssue: 42,
        linkedWorkItem: {
          provider: 'jira',
          type: 'issue',
          number: 123,
          title: 'Fix checkout',
          url: 'https://acme.atlassian.net/browse/PROJ-123',
          jiraIdentifier: 'PROJ-123'
        }
      })
    )
    expect(linked?.provider).toBe('github')
  })
})

describe('resolveIssuePaneLinkedIssue', () => {
  it('drops providers the pane cannot render', () => {
    expect(resolveIssuePaneLinkedIssue(source({ linkedGitLabIssue: 5 }))).toBeNull()
    expect(resolveIssuePaneLinkedIssue(source({ linkedIssue: 1 }))?.provider).toBe('github')
    expect(resolveIssuePaneLinkedIssue(source({ linkedLinearIssue: 'ENG-1' }))?.provider).toBe(
      'linear'
    )
    expect(
      resolveIssuePaneLinkedIssue(
        source({
          linkedWorkItem: {
            provider: 'jira',
            type: 'issue',
            number: 1,
            title: 'x',
            url: 'https://acme.atlassian.net/browse/PROJ-1',
            jiraIdentifier: 'PROJ-1'
          }
        })
      )?.provider
    ).toBe('jira')
  })

  it('returns null for a missing worktree', () => {
    expect(resolveIssuePaneLinkedIssue(null)).toBeNull()
    expect(resolveIssuePaneLinkedIssue(undefined)).toBeNull()
  })
})
