// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getRuntimeGitBranchCompare: vi.fn()
}))

vi.mock('@/runtime/runtime-git-diff-client', () => ({
  getRuntimeGitBranchCompare: mocks.getRuntimeGitBranchCompare
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
  activeReview
}: {
  isPanelVisible: boolean
  activeReview: { baseRefName?: string } | null
}): null {
  useChecksPanelBranchCompareWarmup({
    activeReview,
    activeWorktree: { baseRef: 'main', head: HEAD },
    activeWorktreeId: WORKTREE_ID,
    activeWorktreePath: '/repo/worktree',
    isFolder: false,
    isPanelVisible,
    repo: { worktreeBaseRef: undefined }
  })
  return null
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  mocks.getRuntimeGitBranchCompare.mockReset()
  mocks.getRuntimeGitBranchCompare.mockResolvedValue({ summary: summary(), entries: [] })
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

  it('reuses a compare that already answers for this base and head', async () => {
    useAppStore.setState({
      gitBranchCompareSummaryByWorktree: { [WORKTREE_ID]: summary() }
    })
    await mountProbe(<Probe isPanelVisible activeReview={DEFAULT_REVIEW} />)
    await flush()

    expect(mocks.getRuntimeGitBranchCompare).not.toHaveBeenCalled()
    unmountProbes()
  })

  it('works when the panel is off screen or the worktree carries no review', async () => {
    await mountProbe(<Probe isPanelVisible={false} activeReview={DEFAULT_REVIEW} />)
    await flush()
    unmountProbes()
    await mountProbe(<Probe isPanelVisible activeReview={null} />)
    await flush()

    expect(mocks.getRuntimeGitBranchCompare).not.toHaveBeenCalled()
    unmountProbes()
  })
})
