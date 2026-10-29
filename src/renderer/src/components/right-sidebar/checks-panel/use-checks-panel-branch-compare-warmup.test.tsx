// @vitest-environment happy-dom

import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getRuntimeGitBranchCompare: vi.fn(),
  getRuntimeRepoBaseRefDefault: vi.fn()
}))

vi.mock('@/runtime/runtime-git-diff-client', () => ({
  getRuntimeGitBranchCompare: mocks.getRuntimeGitBranchCompare
}))
vi.mock('@/runtime/runtime-repo-client', () => ({
  getRuntimeRepoBaseRefDefault: mocks.getRuntimeRepoBaseRefDefault
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('../worktree-git-owner-target', () => ({
  // SAFETY: the hook only forwards this value into the mocked RPC context.
  getWorktreeGitOwnerTarget: () => ({ kind: 'local' }) as const
}))

import { useAppStore } from '@/store'
import type { GitBranchCompareSummary } from '../../../../../shared/git-diff-compare-types'
import { useChecksPanelBranchCompareWarmup } from './use-checks-panel-branch-compare-warmup'
import { flush, mountProbe, unmountProbes } from '../source-control-hook-test-harness'

const WORKTREE_ID = 'worktree-A'
const REPO_ID = 'repo-A'
const HEAD = 'b'.repeat(40)

function summary(overrides: Partial<GitBranchCompareSummary> = {}): GitBranchCompareSummary {
  return {
    baseRef: 'main',
    baseOid: 'a'.repeat(40),
    compareRef: 'HEAD',
    headOid: HEAD,
    mergeBase: 'a'.repeat(40),
    changedFiles: 1,
    status: 'ready',
    ...overrides
  }
}

const DEFAULT_REVIEW = { baseRefName: 'main' }

function Probe({
  isPanelVisible,
  activeReview,
  worktreeBaseRef = 'main'
}: {
  isPanelVisible: boolean
  activeReview: { baseRefName?: string } | null
  worktreeBaseRef?: string | null
}): null {
  useChecksPanelBranchCompareWarmup({
    activeReview,
    activeWorktree: { baseRef: worktreeBaseRef ?? undefined, head: HEAD },
    activeWorktreeId: WORKTREE_ID,
    activeWorktreePath: '/repo/worktree',
    isFolder: false,
    isPanelVisible,
    remoteStatus: undefined,
    repo: { id: REPO_ID, executionHostId: 'local', worktreeBaseRef: undefined },
    settings: { sourceControlCompareAgainstUpstream: false }
  })
  return null
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  mocks.getRuntimeGitBranchCompare.mockReset()
  mocks.getRuntimeGitBranchCompare.mockResolvedValue({ summary: summary(), entries: [] })
  mocks.getRuntimeRepoBaseRefDefault.mockReset()
  mocks.getRuntimeRepoBaseRefDefault.mockResolvedValue({ defaultBaseRef: 'origin/main' })
})

describe('useChecksPanelBranchCompareWarmup', () => {
  it('loads the compare the comment jump needs, then stores it', async () => {
    await mountProbe(<Probe isPanelVisible activeReview={DEFAULT_REVIEW} />)
    await flush()

    expect(mocks.getRuntimeGitBranchCompare).toHaveBeenCalledOnce()
    expect(mocks.getRuntimeGitBranchCompare.mock.calls[0][1]).toBe('main')
    expect(useAppStore.getState().gitBranchCompareSummaryByWorktree[WORKTREE_ID]?.status).toBe(
      'ready'
    )
    unmountProbes()
  })

  it('asks for the review diff when nothing is pinned, resolving its base through the repo default', async () => {
    await mountProbe(<Probe isPanelVisible activeReview={DEFAULT_REVIEW} worktreeBaseRef={null} />)
    await flush()
    await flush()

    expect(mocks.getRuntimeGitBranchCompare).toHaveBeenCalledOnce()
    expect(mocks.getRuntimeGitBranchCompare.mock.calls[0][1]).toBe('origin/main')
    unmountProbes()
  })

  it('maps the review base onto the repo default when the worktree pins a commit', async () => {
    await mountProbe(
      <Probe
        isPanelVisible
        activeReview={{ baseRefName: 'release/2.0' }}
        worktreeBaseRef={'a'.repeat(40)}
      />
    )
    await flush()
    await flush()

    expect(mocks.getRuntimeGitBranchCompare.mock.calls[0][1]).toBe('origin/release/2.0')
    unmountProbes()
  })

  it('reuses a compare that already answers for this base and head', async () => {
    useAppStore.setState({
      gitBranchCompareSummaryByWorktree: { [WORKTREE_ID]: summary() }
    })
    await mountProbe(<Probe isPanelVisible activeReview={DEFAULT_REVIEW} />)
    await flush()

    expect(mocks.getRuntimeGitBranchCompare).not.toHaveBeenCalled()
    unmountProbes()
  })

  it('asks again after a failed compare, so a reconnecting host is not frozen out', async () => {
    mocks.getRuntimeGitBranchCompare.mockRejectedValueOnce(new Error('host not connected'))
    const root = await mountProbe(<Probe isPanelVisible activeReview={DEFAULT_REVIEW} />)
    await flush()
    expect(mocks.getRuntimeGitBranchCompare).toHaveBeenCalledOnce()

    await act(async () => {
      root.render(<Probe isPanelVisible={false} activeReview={DEFAULT_REVIEW} />)
    })
    await act(async () => {
      root.render(<Probe isPanelVisible activeReview={DEFAULT_REVIEW} />)
    })
    await flush()

    expect(mocks.getRuntimeGitBranchCompare).toHaveBeenCalledTimes(2)
    unmountProbes()
  })

  it('skips while the panel is off screen or the worktree carries no review', async () => {
    await mountProbe(<Probe isPanelVisible={false} activeReview={DEFAULT_REVIEW} />)
    await flush()
    unmountProbes()
    await mountProbe(<Probe isPanelVisible activeReview={null} />)
    await flush()

    expect(mocks.getRuntimeGitBranchCompare).not.toHaveBeenCalled()
    unmountProbes()
  })
})
