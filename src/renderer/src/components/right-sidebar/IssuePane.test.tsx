// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorkspaceAttachmentSourceContext } from '../sidebar/workspace-attachment-source-result'
import IssuePane from './IssuePane'

const mocks = vi.hoisted(
  (): {
    worktree: Worktree | null
    repo: Repo | null
    /** Every source the Jira pane was handed, so a re-render's identity is checkable. */
    jiraSources: TaskSourceContext[]
  } => ({ worktree: null, repo: null, jiraSources: [] })
)

vi.mock('@/store/selectors', () => ({
  useActiveWorktree: () => mocks.worktree,
  useRepoById: () => mocks.repo
}))
vi.mock('./GithubLinkedIssuePane', () => ({
  GithubLinkedIssuePane: ({
    linkedIssue,
    issueSwitcher
  }: {
    linkedIssue: { identifier: string }
    issueSwitcher?: {
      options: readonly { key: string }[]
      onSelectIssue: (key: string) => void
    }
  }) => (
    <>
      <output data-testid="github-issue">{linkedIssue.identifier}</output>
      {issueSwitcher && issueSwitcher.options.length > 1 ? (
        <button
          type="button"
          onClick={() => issueSwitcher.onSelectIssue(issueSwitcher.options[1]?.key ?? '')}
        >
          select-second
        </button>
      ) : null}
    </>
  )
}))
vi.mock('./JiraLinkedIssuePane', () => ({
  JiraLinkedIssuePane: ({ sourceContext }: { sourceContext: TaskSourceContext }) => {
    mocks.jiraSources.push(sourceContext)
    return <output data-testid="jira-source">{JSON.stringify(sourceContext)}</output>
  }
}))
vi.mock('./LinearLinkedIssuePane', () => ({
  LinearLinkedIssuePane: ({
    sourceContext,
    issueSwitcher
  }: {
    sourceContext: TaskSourceContext
    issueSwitcher?: {
      options: readonly { key: string }[]
      onSelectIssue: (key: string) => void
    }
  }) => (
    <>
      <output data-testid="linear-source">{JSON.stringify(sourceContext)}</output>
      {issueSwitcher && issueSwitcher.options.length > 1 ? (
        <button
          type="button"
          onClick={() => issueSwitcher.onSelectIssue(issueSwitcher.options[1]?.key ?? '')}
        >
          select-second-linear
        </button>
      ) : null}
    </>
  )
}))

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/tmp/repo-1',
    displayName: 'repo-1',
    badgeColor: '#000',
    addedAt: 0,
    connectionId: null,
    executionHostId: null,
    ...overrides
  }
}

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/tmp/wt',
    repoId: 'repo-1',
    hostId: 'runtime:workspace-host',
    path: '/tmp/wt',
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'wt',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabIssue: null,
    linkedWorkItem: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

const jiraTaskSource: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'jira-project',
  hostId: 'runtime:jira-task-host'
}
const linearTaskSource: TaskSourceContext = {
  kind: 'task-source',
  provider: 'linear',
  projectId: 'linear-project',
  hostId: 'runtime:linear-task-host'
}

/** A Jira work item, so the pane can be rendered for a link with no Linear or GitHub slot. */
function jiraWorkItem(key: string): NonNullable<Worktree['linkedWorkItem']> {
  return {
    provider: 'jira',
    type: 'issue',
    number: 0,
    title: key,
    url: `https://jira.invalid/browse/${key}`,
    jiraIdentifier: key
  }
}

function linearWorkItem(key: string): NonNullable<Worktree['linkedWorkItem']> {
  return {
    provider: 'linear',
    type: 'issue',
    number: 0,
    title: key,
    url: `https://linear.invalid/${key}`,
    linearIdentifier: key
  }
}

function sourceShown(testId: 'jira-source' | 'linear-source'): TaskSourceContext {
  const text = screen.getByTestId(testId).textContent ?? ''
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pane renders the source it was handed as JSON.
  return JSON.parse(text) as TaskSourceContext
}

afterEach(() => {
  cleanup()
  mocks.repo = null
  mocks.jiraSources.length = 0
})

describe('IssuePane linked-issue owner', () => {
  it('uses a creation-time task source of the same provider', () => {
    mocks.worktree = worktree({
      linkedLinearIssue: 'LIN-1',
      linkedTaskSourceContext: linearTaskSource
    })
    render(<IssuePane />)

    expect(sourceShown('linear-source')).toEqual(linearTaskSource)
  })

  it("does not route a Linear link through the Jira task's host", () => {
    // A workspace created from a Jira task keeps that source when a Linear link is added later,
    // and the Linear link wins the pane. Routing by the Jira host would ask a server that may have
    // no Linear account at all.
    const current = worktree({
      linkedLinearIssue: 'LIN-1',
      linkedTaskSourceContext: jiraTaskSource,
      linkedWorkItem: jiraWorkItem('JIR-1')
    })
    mocks.worktree = current
    render(<IssuePane />)

    expect(sourceShown('linear-source')).toMatchObject({
      provider: 'linear',
      hostId: 'runtime:workspace-host'
    })
  })

  it('names the same source the workspace card resolves, so neither can go stale', () => {
    // The card, the attachment search and this pane share one resolver; a cache patch scoped to one
    // of them has to land under the key the others read.
    const current = worktree({
      linkedWorkItem: linearWorkItem('LIN-2'),
      linkedLinearIssueWorkspaceId: 'linear-workspace-1'
    })
    mocks.worktree = current
    render(<IssuePane />)

    expect(sourceShown('linear-source')).toEqual(
      getWorkspaceAttachmentSourceContext('linear', undefined, current)
    )
  })

  it('reads through the paired server that transports an SSH workspace', () => {
    // An SSH workspace behind a paired server keeps `ssh:<target>` as its host and names the server
    // separately; the server holds the Jira/Linear credentials, so this computer must not answer.
    mocks.worktree = worktree({
      hostId: 'ssh:example',
      runtimeOwnerEnvironmentId: 'server-1',
      linkedWorkItem: jiraWorkItem('JIR-4')
    })
    render(<IssuePane />)

    expect(sourceShown('jira-source')).toMatchObject({ hostId: 'runtime:server-1' })
  })

  it('uses the repository host when the workspace row names none', () => {
    // Pre-project-host rows carry no host, and the repo row is the owner they fall back to.
    mocks.repo = repo({ executionHostId: 'runtime:repo-host' })
    mocks.worktree = worktree({ hostId: undefined, linkedWorkItem: jiraWorkItem('JIR-5') })
    render(<IssuePane />)

    expect(sourceShown('jira-source')).toMatchObject({ hostId: 'runtime:repo-host' })
  })

  it('keeps one source reference across a row write that changes nothing an owner uses', () => {
    // A PTY bind bumps `lastActivityAt` on the active row, so the store replaces the object; the
    // panes refetch on their source's identity, which must not follow a routine row write.
    mocks.worktree = worktree({ linkedWorkItem: jiraWorkItem('JIR-6') })
    const view = render(<IssuePane />)
    const first = mocks.jiraSources.at(-1)

    mocks.worktree = { ...mocks.worktree, lastActivityAt: 1 }
    view.rerender(<IssuePane />)

    // Why the length: a memoised child would make the reference check vacuous.
    expect(mocks.jiraSources).toHaveLength(2)
    expect(mocks.jiraSources.at(-1)).toBe(first)
  })

  it('uses the workspace host for a hand-linked issue', () => {
    mocks.worktree = worktree({ linkedWorkItem: jiraWorkItem('JIR-9') })
    render(<IssuePane />)

    expect(sourceShown('jira-source')).toMatchObject({
      kind: 'task-source',
      provider: 'jira',
      hostId: 'runtime:workspace-host'
    })
  })
})

describe('IssuePane issue selection', () => {
  it("shows the workspace's own issue first and swaps to the one picked", () => {
    mocks.worktree = worktree({
      linkedIssue: 12,
      linkedItems: [
        { provider: 'github', type: 'issue', number: 12, title: 'Crash on launch' },
        { provider: 'github', type: 'issue', number: 13, title: 'Checkout is slow' }
      ]
    })
    render(<IssuePane />)

    expect(screen.getByTestId('github-issue').textContent).toBe('#12')

    fireEvent.click(screen.getByText('select-second'))

    expect(screen.getByTestId('github-issue').textContent).toBe('#13')
  })

  it('offers no choice for a workspace with a single issue', () => {
    mocks.worktree = worktree({ linkedIssue: 12 })
    render(<IssuePane />)

    expect(screen.getByTestId('github-issue').textContent).toBe('#12')
    expect(screen.queryByText('select-second')).toBeNull()
  })

  it("routes the picked issue's reads through that issue's own account", () => {
    // The workspace's source is the fallback for a link that predates attachments; an attachment
    // that recorded another host has to win, or the pane reads one server's account for another
    // server's issue.
    const otherHost: TaskSourceContext = {
      kind: 'task-source',
      provider: 'linear',
      projectId: 'linear-project',
      hostId: 'runtime:other-host'
    }
    mocks.worktree = worktree({
      linkedWorkItem: linearWorkItem('LIN-1'),
      linkedItems: [
        { provider: 'linear', type: 'issue', number: 0, identifier: 'LIN-1' },
        {
          provider: 'linear',
          type: 'issue',
          number: 0,
          identifier: 'LIN-2',
          taskSourceContext: otherHost
        }
      ]
    })
    render(<IssuePane />)

    expect(sourceShown('linear-source')).toMatchObject({ hostId: 'runtime:workspace-host' })

    fireEvent.click(screen.getByText('select-second-linear'))

    expect(sourceShown('linear-source')).toMatchObject({ hostId: 'runtime:other-host' })
  })
})
