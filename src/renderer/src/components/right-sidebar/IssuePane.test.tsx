// @vitest-environment happy-dom

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import IssuePane from './IssuePane'

const mocks = vi.hoisted(() => {
  const state: { worktree: unknown } = { worktree: null }
  return state
})

vi.mock('@/store/selectors', () => ({
  useActiveWorktree: () => mocks.worktree
}))
vi.mock('./GithubLinkedIssuePane', () => ({
  GithubLinkedIssuePane: () => <div data-testid="github-pane" />
}))
vi.mock('./LinearLinkedIssuePane', () => ({
  LinearLinkedIssuePane: () => <div data-testid="linear-pane" />
}))
vi.mock('./JiraLinkedIssuePane', () => ({
  JiraLinkedIssuePane: () => <div data-testid="jira-pane" />
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback?: string) => fallback ?? _key
}))

function baseWorktree(overrides: Record<string, unknown> = {}) {
  return {
    id: 'worktree-1',
    linkedIssue: null,
    linkedLinearIssue: null,
    linkedLinearIssueWorkspaceId: null,
    linkedLinearIssueOrganizationUrlKey: null,
    linkedGitLabIssue: null,
    linkedWorkItem: null,
    linkedTaskSourceContext: null,
    repoId: 'repo-1',
    ...overrides
  }
}

describe('IssuePane', () => {
  it('shows the no-link state when there is no active worktree', () => {
    mocks.worktree = null
    expect(renderToStaticMarkup(<IssuePane />)).toContain('No issue is linked to this workspace.')
  })

  it('shows the no-link state when the active worktree has no linked issue', () => {
    mocks.worktree = baseWorktree()
    expect(renderToStaticMarkup(<IssuePane />)).toContain('No issue is linked to this workspace.')
  })

  it('dispatches to the GitHub pane for a GitHub link', () => {
    mocks.worktree = baseWorktree({ linkedIssue: 42 })
    expect(renderToStaticMarkup(<IssuePane />)).toContain('data-testid="github-pane"')
  })

  it('dispatches to the Linear pane for a Linear link', () => {
    mocks.worktree = baseWorktree({ linkedLinearIssue: 'ENG-42' })
    expect(renderToStaticMarkup(<IssuePane />)).toContain('data-testid="linear-pane"')
  })

  it('dispatches to the Jira pane for a Jira work item', () => {
    mocks.worktree = baseWorktree({
      linkedWorkItem: {
        provider: 'jira',
        type: 'issue',
        number: 1,
        title: 'x',
        url: 'https://acme.atlassian.net/browse/PROJ-1',
        jiraIdentifier: 'PROJ-1'
      }
    })
    expect(renderToStaticMarkup(<IssuePane />)).toContain('data-testid="jira-pane"')
  })

  it('shows the no-link state for a provider the pane cannot render', () => {
    mocks.worktree = baseWorktree({ linkedGitLabIssue: 5 })
    expect(renderToStaticMarkup(<IssuePane />)).toContain('No issue is linked to this workspace.')
  })
})
