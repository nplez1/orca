import { describe, expect, it } from 'vitest'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { WorkspaceAttachment, Worktree } from '../../../../shared/worktree/types'
import {
  findWorkspaceIssueAttachment,
  resolveIssuePaneIssues,
  resolveIssuePaneLinkedIssue,
  resolveWorkspaceLinkedIssue
} from './workspace-linked-issue'

type LinkedIssueSource = Pick<
  Worktree,
  | 'linkedIssue'
  | 'linkedLinearIssue'
  | 'linkedLinearIssueWorkspaceId'
  | 'linkedLinearIssueOrganizationUrlKey'
  | 'linkedGitLabIssue'
  | 'linkedWorkItem'
  | 'linkedItems'
>

function source(overrides: Partial<LinkedIssueSource> = {}): LinkedIssueSource {
  return {
    linkedIssue: null,
    linkedLinearIssue: null,
    linkedLinearIssueWorkspaceId: null,
    linkedLinearIssueOrganizationUrlKey: null,
    linkedGitLabIssue: null,
    linkedWorkItem: null,
    linkedItems: [],
    ...overrides
  }
}

function githubIssue(number: number, title?: string): WorkspaceAttachment {
  return { provider: 'github', type: 'issue', number, ...(title ? { title } : {}) }
}

function jiraIssue(key: string, title?: string): WorkspaceAttachment {
  return {
    provider: 'jira',
    type: 'issue',
    number: 0,
    identifier: key,
    jiraIdentifier: key,
    ...(title ? { title } : {})
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

const githubSource: TaskSourceContext = {
  kind: 'task-source',
  provider: 'github',
  projectId: 'github-project',
  hostId: 'runtime:github-host'
}

describe('resolveIssuePaneIssues', () => {
  it('lists every attached issue, putting the workspace own one first', () => {
    const issues = resolveIssuePaneIssues(
      source({
        linkedIssue: 13,
        linkedItems: [githubIssue(12, 'Crash on launch'), githubIssue(13), jiraIssue('PROJ-7')]
      })
    )

    expect(issues.map((entry) => entry.issue.identifier)).toEqual(['#13', '#12', 'PROJ-7'])
  })

  it('keeps the account each issue was attached from', () => {
    const issues = resolveIssuePaneIssues(
      source({ linkedItems: [{ ...githubIssue(12), taskSourceContext: githubSource }] })
    )

    expect(issues[0]?.sourceContext).toMatchObject({
      provider: 'github',
      hostId: 'runtime:github-host'
    })
  })

  it('titles an issue from its attachment so the picker can show it', () => {
    const issues = resolveIssuePaneIssues(
      source({ linkedItems: [githubIssue(12, 'Crash on launch')] })
    )

    expect(issues.map((entry) => entry.issue.title)).toEqual(['Crash on launch'])
  })

  it('synthesizes the active issue when no attachment carries it yet', () => {
    // The slot can name an issue before `linkedItems` lists it, and the pane still has to show it.
    expect(
      resolveIssuePaneIssues(source({ linkedIssue: 12 })).map((entry) => entry.issue.identifier)
    ).toEqual(['#12'])
  })

  it('drops providers the pane has no detail body for', () => {
    expect(resolveIssuePaneIssues(source({ linkedGitLabIssue: 5 }))).toEqual([])
    expect(
      resolveIssuePaneIssues(source({ linkedGitLabIssue: 5, linkedItems: [githubIssue(9)] })).map(
        (entry) => entry.issue.identifier
      )
    ).toEqual(['#9'])
  })

  it('lists each issue once when an attachment and a slot name the same issue', () => {
    expect(
      resolveIssuePaneIssues(source({ linkedIssue: 12, linkedItems: [githubIssue(12)] })).map(
        (entry) => entry.key
      )
    ).toEqual(['github:#12'])
  })

  it('returns nothing for a missing worktree', () => {
    expect(resolveIssuePaneIssues(null)).toEqual([])
    expect(resolveIssuePaneIssues(undefined)).toEqual([])
  })
})

describe('findWorkspaceIssueAttachment', () => {
  it('addresses the issue the pane shows rather than the active one', () => {
    const worktree = source({ linkedIssue: 12, linkedItems: [githubIssue(12), githubIssue(13)] })

    expect(
      findWorkspaceIssueAttachment(worktree, { provider: 'github', identifier: '#13' })
    ).toMatchObject({ provider: 'github', number: 13 })
    expect(
      findWorkspaceIssueAttachment(worktree, { provider: 'jira', identifier: 'PROJ-7' })
    ).toBeNull()
  })

  it('matches a Jira key through its own identifier field', () => {
    expect(
      findWorkspaceIssueAttachment(source({ linkedItems: [jiraIssue('PROJ-7')] }), {
        provider: 'jira',
        identifier: 'PROJ-7'
      })
    ).toMatchObject({ provider: 'jira', jiraIdentifier: 'PROJ-7' })
  })
})
