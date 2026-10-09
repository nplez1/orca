import { describe, expect, it } from 'vitest'
import type { JiraIssue, JiraSite } from '../../../shared/jira-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { isWorkspaceLinkedItemSourceContextMatch } from '../../../shared/workspace-linked-item-source-context'
import { bindTaskPageJiraItemSourceContext } from './task-page-jira-item-source-context'

const SOURCE_CONTEXT: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'project-1',
  hostId: 'runtime:env-1'
}

const SITES: JiraSite[] = [
  {
    id: 'site-a',
    siteUrl: 'https://a.atlassian.net',
    email: 'a@example.com',
    displayName: 'Site A',
    accountId: 'account-a'
  },
  {
    id: 'site-b',
    siteUrl: 'https://b.atlassian.net/jira',
    email: 'b@example.com',
    displayName: 'Site B',
    accountId: 'account-b'
  }
]

function jiraIssue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: 'issue-1',
    key: 'ORCA-123',
    siteId: 'site-b',
    siteName: 'Site B',
    title: 'Fix checkout',
    description: '',
    url: 'https://b.atlassian.net/jira/browse/ORCA-123',
    project: { id: 'project-1', key: 'ORCA', name: 'Orca' },
    issueType: { id: 'story', name: 'Story' },
    status: { id: 'new', name: 'To Do', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

/** The item the Tasks page hands the composer, from the same issue. */
function linkedItem(issue: JiraIssue): {
  provider: 'jira'
  type: 'issue'
  number: number
  title: string
  url: string
  jiraIdentifier: string
} {
  return {
    provider: 'jira',
    type: 'issue',
    number: 0,
    title: `${issue.key} ${issue.title}`,
    url: issue.url,
    jiraIdentifier: issue.key
  }
}

describe('TaskPage Jira item source context', () => {
  it('binds an All-sites result to its originating Jira site and project', () => {
    expect(
      bindTaskPageJiraItemSourceContext({
        issue: jiraIssue(),
        sites: SITES,
        sourceContext: SOURCE_CONTEXT
      })
    ).toMatchObject({
      hostId: 'runtime:env-1',
      accountLabel: 'b@example.com',
      providerIdentity: {
        provider: 'jira',
        siteId: 'site-b',
        siteUrl: 'https://b.atlassian.net/jira',
        projectKey: 'ORCA'
      }
    })
  })

  // The composer drops an item whose context does not pair with it, and says
  // nothing. A `project` field that disagrees with the key is exactly that case.
  it('takes the project key from the issue key when the project field disagrees', () => {
    const issue = jiraIssue({ project: { id: 'project-2', key: 'RENAMED', name: 'Renamed' } })

    const context = bindTaskPageJiraItemSourceContext({
      issue,
      sites: SITES,
      sourceContext: SOURCE_CONTEXT
    })

    expect(context?.providerIdentity).toMatchObject({ projectKey: 'ORCA' })
    expect(isWorkspaceLinkedItemSourceContextMatch(linkedItem(issue), context)).toBe(true)
  })

  it('still pairs when the project field is missing entirely', () => {
    const issue = jiraIssue({ project: { id: '', key: '', name: '' } })

    const context = bindTaskPageJiraItemSourceContext({
      issue,
      sites: SITES,
      sourceContext: SOURCE_CONTEXT
    })

    expect(isWorkspaceLinkedItemSourceContextMatch(linkedItem(issue), context)).toBe(true)
  })

  it('pairs on a self-hosted site whose URL carries a context path', () => {
    const site: JiraSite = {
      id: 'site-c',
      siteUrl: 'https://jira.corp.adobe.com/jira',
      email: '',
      displayName: 'Adobe Jira',
      accountId: 'nathanp',
      authType: 'server'
    }
    const issue = jiraIssue({
      siteId: 'site-c',
      url: 'https://jira.corp.adobe.com/jira/browse/ORCA-123'
    })

    const context = bindTaskPageJiraItemSourceContext({
      issue,
      sites: [site],
      sourceContext: SOURCE_CONTEXT
    })

    expect(isWorkspaceLinkedItemSourceContextMatch(linkedItem(issue), context)).toBe(true)
  })

  // Refusing is loud (the composer toasts); building an unpaired context is silent.
  it('refuses an issue whose URL is not a Jira issue URL', () => {
    expect(
      bindTaskPageJiraItemSourceContext({
        issue: jiraIssue({ url: 'https://b.atlassian.net/jira/secure/Dashboard.jspa' }),
        sites: SITES,
        sourceContext: SOURCE_CONTEXT
      })
    ).toBeNull()
  })

  it('refuses an issue whose URL names a different key than the issue', () => {
    expect(
      bindTaskPageJiraItemSourceContext({
        issue: jiraIssue({ url: 'https://b.atlassian.net/jira/browse/OTHER-9' }),
        sites: SITES,
        sourceContext: SOURCE_CONTEXT
      })
    ).toBeNull()
  })

  it('refuses to bind an issue whose originating site is unavailable', () => {
    expect(
      bindTaskPageJiraItemSourceContext({
        issue: jiraIssue({ siteId: 'missing' }),
        sites: SITES,
        sourceContext: SOURCE_CONTEXT
      })
    ).toBeNull()
  })

  it('refuses a workspace whose source is not Jira', () => {
    expect(
      bindTaskPageJiraItemSourceContext({
        issue: jiraIssue(),
        sites: SITES,
        sourceContext: { ...SOURCE_CONTEXT, provider: 'github' }
      })
    ).toBeNull()
  })
})
