// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { GithubLinkedIssuePane } from './GithubLinkedIssuePane'
import type { SupportedWorkspaceLinkedIssue } from './workspace-linked-issue'

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  // Why: the real store returns the stored repo object, so the selector result is
  // referentially stable. A fresh object per render would re-create `load` and
  // re-run the fetch effect forever.
  repoState: { repos: [{ id: 'repo-1', path: '/tmp/repo' }] }
}))

vi.mock('@/lib/github-work-item-source-lookup', () => ({
  lookupGitHubWorkItemForSource: (...args: unknown[]) => mocks.lookup(...args)
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(mocks.repoState)
}))
vi.mock('@/components/github-item-dialog/load-item-details/use-github-item-dialog-details', () => ({
  useGitHubItemDialogDetails: () => ({
    details: null,
    displayWorkItem: null,
    invalidateCurrentDetailsCache: () => {}
  })
}))
vi.mock('@/components/github-item-dialog/edit-item-fields/gh-edit-section', () => ({
  GHEditSection: () => null
}))
vi.mock('@/components/sidebar/CommentMarkdown', () => ({ default: () => null }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback?: string) => fallback ?? _key
}))

const worktree: Pick<Worktree, 'id' | 'repoId' | 'linkedWorkItem' | 'linkedTaskSourceContext'> = {
  id: 'worktree-1',
  repoId: 'repo-1',
  linkedWorkItem: null,
  linkedTaskSourceContext: null
}

const linkedIssue: Extract<SupportedWorkspaceLinkedIssue, { provider: 'github' }> = {
  provider: 'github',
  number: 7,
  identifier: '#7',
  url: 'https://github.com/acme/orca/issues/7',
  title: null
}

const nextLinkedIssue: Extract<SupportedWorkspaceLinkedIssue, { provider: 'github' }> = {
  provider: 'github',
  number: 8,
  identifier: '#8',
  url: 'https://github.com/acme/orca/issues/8',
  title: null
}

function item(title: string): GitHubWorkItem {
  return {
    id: 'issue-7',
    type: 'issue',
    number: 7,
    title,
    state: 'open',
    url: 'https://github.com/acme/orca/issues/7',
    labels: [],
    updatedAt: '2026-09-01T00:00:00.000Z',
    author: null,
    repoId: 'repo-1'
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('GithubLinkedIssuePane', () => {
  it('ignores a slower earlier lookup that resolves after a newer one', async () => {
    let resolveFirst: ((value: GitHubWorkItem) => void) | undefined
    let resolveSecond: ((value: GitHubWorkItem) => void) | undefined
    mocks.lookup
      .mockImplementationOnce(
        () => new Promise<GitHubWorkItem>((resolve) => (resolveFirst = resolve))
      )
      .mockImplementationOnce(
        () => new Promise<GitHubWorkItem>((resolve) => (resolveSecond = resolve))
      )

    const { rerender } = render(
      <TooltipProvider delayDuration={0}>
        <GithubLinkedIssuePane worktree={worktree} linkedIssue={linkedIssue} sourceContext={null} />
      </TooltipProvider>
    )
    // Re-link while the first lookup is still in flight; the newer request wins.
    rerender(
      <TooltipProvider delayDuration={0}>
        <GithubLinkedIssuePane
          worktree={worktree}
          linkedIssue={nextLinkedIssue}
          sourceContext={null}
        />
      </TooltipProvider>
    )

    await waitFor(() => expect(mocks.lookup).toHaveBeenCalledTimes(2))

    resolveSecond?.(item('Second'))
    await waitFor(() => expect(screen.getByText('Second')).toBeTruthy())

    resolveFirst?.(item('First'))
    await waitFor(() => expect(screen.getByText('Second')).toBeTruthy())
    expect(screen.queryByText('First')).toBeNull()
  })
})
