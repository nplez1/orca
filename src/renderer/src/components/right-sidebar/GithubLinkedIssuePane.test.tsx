// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { GithubLinkedIssuePane } from './GithubLinkedIssuePane'
import type { SupportedWorkspaceLinkedIssue } from './workspace-linked-issue'

const mocks = vi.hoisted(() => {
  type MockRepoState = {
    repos: { id: string; path: string; executionHostId?: string | null }[]
    settings: null
  }
  // Why: the real store returns the stored repo object, so the selector result is
  // referentially stable. A fresh object per render would re-create `load` and
  // re-run the fetch effect forever.
  const repoState: MockRepoState = { repos: [{ id: 'repo-1', path: '/tmp/repo' }], settings: null }
  return { lookup: vi.fn(), repoState }
})

vi.mock('@/lib/github-work-item-source-lookup', () => ({
  lookupGitHubWorkItemForSource: (...args: unknown[]) => mocks.lookup(...args)
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(mocks.repoState), {
    getState: () => mocks.repoState
  })
}))
vi.mock('@/components/github-item-dialog/load-item-details/use-github-item-dialog-details', () => ({
  useGitHubItemDialogDetails: () => ({
    details: null,
    displayWorkItem: null,
    invalidateCurrentDetailsCache: () => {},
    appendOptimisticComment: () => {},
    loading: false,
    error: null
  })
}))
vi.mock('@/components/github-item-dialog/edit-item-fields/gh-edit-section', () => ({
  GHEditSection: () => null
}))
vi.mock('@/components/github-item-dialog/discuss-item/gh-comment-composer', () => ({
  GHCommentComposer: () => null
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

const linkedWorkItem: Worktree['linkedWorkItem'] = {
  provider: 'github',
  type: 'issue',
  number: 7,
  title: 'Fix checkout',
  url: 'https://github.com/acme/orca/issues/7',
  repoId: 'repo-source'
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
  mocks.repoState = { repos: [{ id: 'repo-1', path: '/tmp/repo' }], settings: null }
})

describe('GithubLinkedIssuePane', () => {
  // The pane offers the same unlink / re-link actions the workspace dialog owns,
  // for every provider whose link the pane can render.
  it('offers the link actions for a GitHub issue', async () => {
    mocks.lookup.mockResolvedValue(item('Fix checkout'))
    render(
      <TooltipProvider delayDuration={0}>
        <GithubLinkedIssuePane worktree={worktree} linkedIssue={linkedIssue} sourceContext={null} />
      </TooltipProvider>
    )

    await waitFor(() => expect(screen.getByText('Fix checkout')).toBeTruthy())
    expect(screen.getByLabelText('More issue actions')).toBeTruthy()
  })

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

  // Why: this workspace's link is a bare issue number with no task-source context, so the
  // read must follow the repo row's owner host — the task source alone reads on this app's
  // IPC, which refuses a repo a paired server owns.
  it('reads the issue on the repo owner host, not this app', async () => {
    mocks.repoState = {
      repos: [{ id: 'repo-1', path: '/tmp/repo', executionHostId: 'runtime:env-1' }],
      settings: null
    }
    mocks.lookup.mockResolvedValue(item('Fix checkout'))
    render(
      <TooltipProvider delayDuration={0}>
        <GithubLinkedIssuePane worktree={worktree} linkedIssue={linkedIssue} sourceContext={null} />
      </TooltipProvider>
    )

    await waitFor(() => expect(mocks.lookup).toHaveBeenCalled())
    expect(mocks.lookup).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'repo-1',
        sourceContext: null,
        target: { kind: 'environment', environmentId: 'env-1' }
      })
    )
  })

  // Why: a workspace created from a task on another host lives in that project's repo there,
  // while the issue stays in the repo the task was listed from. Reading the workspace repo
  // looked up #97 in the other host's checkout and failed with "Couldn't load this GitHub
  // issue" even though the link was intact.
  it("reads the issue from the linked item's repo, not the workspace repo", async () => {
    mocks.repoState = {
      repos: [
        { id: 'repo-remote', path: '/volumes/remote/repo', executionHostId: 'runtime:env-1' },
        { id: 'repo-source', path: '/tmp/source' }
      ],
      settings: null
    }
    mocks.lookup.mockResolvedValue(item('Cross-host issue'))

    render(
      <TooltipProvider delayDuration={0}>
        <GithubLinkedIssuePane
          worktree={{ ...worktree, repoId: 'repo-remote', linkedWorkItem: linkedWorkItem }}
          linkedIssue={linkedIssue}
          sourceContext={null}
        />
      </TooltipProvider>
    )

    await waitFor(() => expect(screen.getByText('Cross-host issue')).toBeTruthy())
    expect(mocks.lookup.mock.calls[0]?.[0]).toMatchObject({
      repoPath: '/tmp/source',
      repoId: 'repo-source',
      target: { kind: 'local' }
    })
  })

  // Why: `linkedIssue` and `linkedWorkItem` are separate slots and the former wins, so the
  // pane can show an issue the item does not describe. The item's repo is that other item's
  // repo — borrowing it would read the visible number out of the wrong project.
  it.each([
    ['a pull request', { ...linkedWorkItem, type: 'pr' as const }],
    ['a different issue', { ...linkedWorkItem, number: 8 }],
    ['a Linear task', { ...linkedWorkItem, provider: 'linear' as const }]
  ])('does not lend the repo of %s to the linked issue', async (_label, linkedItem) => {
    mocks.repoState = {
      repos: [
        { id: 'repo-remote', path: '/volumes/remote/repo' },
        { id: 'repo-source', path: '/tmp/source' }
      ],
      settings: null
    }
    mocks.lookup.mockResolvedValue(item('Workspace repo issue'))

    render(
      <TooltipProvider delayDuration={0}>
        <GithubLinkedIssuePane
          worktree={{ ...worktree, repoId: 'repo-remote', linkedWorkItem: linkedItem }}
          linkedIssue={linkedIssue}
          sourceContext={null}
        />
      </TooltipProvider>
    )

    await waitFor(() => expect(screen.getByText('Workspace repo issue')).toBeTruthy())
    expect(mocks.lookup.mock.calls[0]?.[0]).toMatchObject({
      repoPath: '/volumes/remote/repo',
      repoId: 'repo-remote'
    })
  })

  // Why no fallback: resolving the same number against the workspace repo would read an
  // unrelated issue in whatever project that repo is, which is worse than saying so. The copy
  // names the actual problem, because retrying cannot fix a repo this device does not have.
  it("says the issue's repo is missing when it is not registered here", async () => {
    render(
      <TooltipProvider delayDuration={0}>
        <GithubLinkedIssuePane
          worktree={{ ...worktree, linkedWorkItem: linkedWorkItem }}
          linkedIssue={linkedIssue}
          sourceContext={null}
        />
      </TooltipProvider>
    )

    // The i18n mock returns the raw fallback, so match the stable phrase only.
    await waitFor(() => expect(screen.getByText(/isn't set up on this device/u)).toBeTruthy())
    expect(mocks.lookup).not.toHaveBeenCalled()
  })

  // Why: a creation-time source context that names another repo re-introduces the host/repo
  // disagreement this pane was fixed for — the row is the read's authority, so the stale
  // context is dropped rather than forwarded.
  it('drops a source context that names a different repo', async () => {
    mocks.repoState = {
      repos: [
        { id: 'repo-remote', path: '/volumes/remote/repo', executionHostId: 'runtime:env-1' },
        { id: 'repo-source', path: '/tmp/source' }
      ],
      settings: null
    }
    mocks.lookup.mockResolvedValue(item('Cross-host issue'))

    render(
      <TooltipProvider delayDuration={0}>
        <GithubLinkedIssuePane
          worktree={{ ...worktree, repoId: 'repo-remote', linkedWorkItem: linkedWorkItem }}
          linkedIssue={linkedIssue}
          sourceContext={{
            kind: 'task-source',
            provider: 'github',
            projectId: 'github:acme/orca',
            hostId: 'local',
            repoId: 'repo-remote'
          }}
        />
      </TooltipProvider>
    )

    await waitFor(() => expect(screen.getByText('Cross-host issue')).toBeTruthy())
    expect(mocks.lookup.mock.calls[0]?.[0]).toMatchObject({
      repoId: 'repo-source',
      sourceContext: null,
      target: { kind: 'local' }
    })
  })

  it('keeps a source context that names the same repo', async () => {
    const sourceContext = {
      kind: 'task-source' as const,
      provider: 'github' as const,
      projectId: 'github:acme/orca',
      hostId: 'local' as const,
      repoId: 'repo-source'
    }
    mocks.repoState = {
      repos: [
        { id: 'repo-remote', path: '/volumes/remote/repo', executionHostId: 'runtime:env-1' },
        { id: 'repo-source', path: '/tmp/source' }
      ],
      settings: null
    }
    mocks.lookup.mockResolvedValue(item('Cross-host issue'))

    render(
      <TooltipProvider delayDuration={0}>
        <GithubLinkedIssuePane
          worktree={{ ...worktree, repoId: 'repo-remote', linkedWorkItem: linkedWorkItem }}
          linkedIssue={linkedIssue}
          sourceContext={sourceContext}
        />
      </TooltipProvider>
    )

    await waitFor(() => expect(screen.getByText('Cross-host issue')).toBeTruthy())
    expect(mocks.lookup.mock.calls[0]?.[0]).toMatchObject({
      repoId: 'repo-source',
      sourceContext
    })
  })
})
