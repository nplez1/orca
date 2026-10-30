import { describe, expect, it } from 'vitest'
import {
  findLinkedIssueRepo,
  linkedIssueRepoId,
  linkedIssueRepoIsOffDevice
} from './linked-issue-repo'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { makeRepo, makeWorktree } from '../components/worktree-jump-palette-test-fixtures'

function repo(id: string, path: string, overrides: Partial<Repo> = {}): Repo {
  return { ...makeRepo(), id, path, ...overrides }
}

const repos = [
  repo('repo-remote', '/volumes/remote/repo', { executionHostId: 'runtime:env-1' }),
  repo('repo-source', '/tmp/source')
]

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return makeWorktree('wt-1', 'Workspace', { repoId: 'repo-remote', ...overrides })
}

const item = {
  provider: 'github' as const,
  type: 'issue' as const,
  number: 97,
  title: 'History shows everything',
  url: 'https://github.com/acme/orca/issues/97',
  repoId: 'repo-source'
}

describe('linkedIssueRepoId', () => {
  it('names the repo the work item came from when the item is the link', () => {
    expect(linkedIssueRepoId(worktree({ linkedWorkItem: item }), 97)).toBe('repo-source')
  })

  it('keeps the workspace repo when the item is not this number', () => {
    // Why: `linkedIssue` wins over `linkedWorkItem`, so the pane can show a number the item
    // does not describe — a PR, another issue, or a provider with no repo of its own.
    expect(linkedIssueRepoId(worktree({ linkedWorkItem: { ...item, number: 12 } }), 97)).toBe(
      'repo-remote'
    )
    expect(linkedIssueRepoId(worktree({ linkedWorkItem: { ...item, type: 'pr' } }), 97)).toBe(
      'repo-remote'
    )
    expect(
      linkedIssueRepoId(worktree({ linkedWorkItem: { ...item, provider: 'linear' } }), 97)
    ).toBe('repo-remote')
  })

  it('falls back to the workspace repo when the item carries no repo id', () => {
    const { repoId: _repoId, ...withoutRepo } = item
    expect(linkedIssueRepoId(worktree({ linkedWorkItem: withoutRepo }), 97)).toBe('repo-remote')
  })
})

describe('findLinkedIssueRepo', () => {
  it('finds the item repo row, not the workspace row', () => {
    expect(findLinkedIssueRepo(repos, worktree({ linkedWorkItem: item }), 97)?.path).toBe(
      '/tmp/source'
    )
  })

  it('returns null rather than another repo when the row is absent', () => {
    expect(findLinkedIssueRepo([repos[0]], worktree({ linkedWorkItem: item }), 97)).toBeNull()
    expect(findLinkedIssueRepo(undefined, worktree({ linkedWorkItem: item }), 97)).toBeNull()
  })
})

describe('linkedIssueRepoIsOffDevice', () => {
  it('reports a known-but-unregistered item repo', () => {
    expect(linkedIssueRepoIsOffDevice([repos[0]], worktree({ linkedWorkItem: item }), 97)).toBe(
      true
    )
  })

  it('is quiet when the item repo is registered or no item names one', () => {
    expect(linkedIssueRepoIsOffDevice(repos, worktree({ linkedWorkItem: item }), 97)).toBe(false)
    // A workspace repo that is simply missing is the card's existing "no row" case, not a
    // claim about where the issue lives.
    expect(linkedIssueRepoIsOffDevice([], worktree(), 97)).toBe(false)
  })
})

describe('an attachment that names its own repo', () => {
  // The Issue pane can show any issue the workspace has attached, and an attachment records the
  // repo it came from. Without it a picked GitHub issue is read from the workspace repo: a folder
  // workspace has a synthetic repo id and shows nothing, and a fork answers with an unrelated issue
  // of the same number.
  it('wins over both the work item and the workspace', () => {
    expect(linkedIssueRepoId(worktree({ linkedWorkItem: item }), 12, 'repo-source')).toBe(
      'repo-source'
    )
    expect(findLinkedIssueRepo(repos, worktree(), 12, 'repo-source')?.path).toBe('/tmp/source')
    expect(linkedIssueRepoIsOffDevice([repos[0]], worktree(), 12, 'repo-source')).toBe(true)
  })

  it('leaves the work-item rule in place when the attachment names none', () => {
    expect(linkedIssueRepoId(worktree({ linkedWorkItem: item }), 97, null)).toBe('repo-source')
    expect(linkedIssueRepoId(worktree(), 97, null)).toBe('repo-remote')
  })
})
