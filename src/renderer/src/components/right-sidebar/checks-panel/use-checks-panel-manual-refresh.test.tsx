// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as HostedReviewCardRefresh from '@/store/slices/hosted-review-card-refresh'

const refresh = vi.hoisted(() => ({ calls: [] as string[] }))

vi.mock('@/store/slices/hosted-review-card-refresh', async (importOriginal) => {
  const original = await importOriginal<typeof HostedReviewCardRefresh>()
  return {
    ...original,
    refreshHostedReviewCard: vi.fn(async () => {
      refresh.calls.push('hosted-review')
      return null
    })
  }
})

import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import type { PRInfo } from '../../../../../shared/github/pull-request-types'
import { useChecksPanelManualRefresh } from './use-checks-panel-manual-refresh'
import { makeWorkspaceReviewSelection } from '../workspace-review-selection.test-fixture'

type RefreshInput = Parameters<typeof useChecksPanelManualRefresh>[0]

afterEach(() => {
  cleanup()
  refresh.calls.length = 0
})

describe('useChecksPanelManualRefresh ordering', () => {
  it('refreshes review identity before starting checks and comments, then clears loading', async () => {
    const refreshedPR = {
      number: 42,
      state: 'open',
      title: 'Current review',
      headSha: 'head-2',
      prRepo: { owner: 'orca', repo: 'app', host: 'github.com' }
    } as NonNullable<RefreshInput['pr']>
    const setChecksLoading: RefreshInput['setChecksLoading'] = vi.fn((loading) => {
      refresh.calls.push(`checks-loading:${String(loading)}`)
    })
    const setCommentsLoading: RefreshInput['setCommentsLoading'] = vi.fn((loading) => {
      refresh.calls.push(`comments-loading:${String(loading)}`)
    })
    const input: RefreshInput = {
      activeConnectionId: null,
      activeGitLabReview: null,
      activeWorktreeId: null,
      activeWorktreePath: null,
      activeWorktreePushTarget: null,
      asyncResultKeyRef: { current: 'cache::main::42' },
      branch: 'main',
      expireGitHubPRRefreshState: vi.fn(),
      fallbackGitHubPRNumber: null,
      fetchGitLabDetails: vi.fn(),
      fetchHostedReviewForBranch: vi.fn(),
      fetchPRChecks: vi.fn(async () => {
        refresh.calls.push('checks')
        return []
      }),
      fetchPRComments: vi.fn(async () => {
        refresh.calls.push('comments')
        return []
      }),
      fetchPRForBranch: vi.fn(async () => {
        refresh.calls.push('review')
        return refreshedPR
      }),
      gitStatusSnapshot: null,
      isCurrentAsyncResult: () => true,
      isFolder: false,
      isGitLabReviewContext: false,
      linkedAzureDevOpsPR: null,
      linkedBitbucketPR: null,
      linkedGiteaPR: null,
      linkedGitLabMR: null,
      linkedPR: null,
      ownerCopyHostId: null,
      ownerTarget: { kind: 'local' },
      panelContextKey: 'repo-1::worktree-1::main',
      panelContextKeyRef: { current: 'repo-1::worktree-1::main' },
      pollIntervalRef: { current: 30_000 },
      pr: refreshedPR,
      prCacheKey: 'cache',
      prNumber: 42,
      prevChecksRef: { current: '' },
      refreshInFlightRef: { current: false },
      refreshRequestKeyRef: { current: '' },
      repo: { id: 'repo-1', path: '/workspace/repo' } as NonNullable<RefreshInput['repo']>,
      reviewSelection: makeWorkspaceReviewSelection(),
      showsPickedReview: false,
      setChecks: vi.fn(),
      setChecksLoading,
      setComments: vi.fn(),
      setCommentsLoading,
      setEligibilityRefreshNonce: vi.fn(),
      setGitStatusSnapshot: vi.fn(),
      setIsRefreshing: vi.fn((loading) => {
        refresh.calls.push(`refreshing:${String(loading)}`)
      }),
      updateWorktreeGitIdentity: vi.fn()
    }
    const { result } = renderHook(() => useChecksPanelManualRefresh(input))

    await act(async () => result.current.handleRefresh())

    expect(refresh.calls).toEqual([
      'refreshing:true',
      'review',
      'hosted-review',
      'checks',
      'checks-loading:true',
      'comments-loading:true',
      'comments',
      'checks-loading:false',
      'comments-loading:false',
      'refreshing:false'
    ])
    expect(input.fetchPRForBranch).toHaveBeenCalledWith('/workspace/repo', 'main', {
      force: true,
      repoId: 'repo-1',
      worktreeId: undefined,
      linkedPRNumber: null,
      fallbackPRNumber: null,
      reason: 'manual'
    })
  })
})

const pickedPR: PRInfo = {
  number: 9,
  state: 'open',
  title: 'Parent change',
  url: 'https://github.com/acme/orca/pull/9',
  checksStatus: 'success',
  updatedAt: '2026-05-17T00:00:00.000Z',
  mergeable: 'MERGEABLE',
  headSha: 'picked-head',
  prRepo: { owner: 'orca', repo: 'app', host: 'github.com' }
}

describe('useChecksPanelManualRefresh for a picked review', () => {
  const WORKTREE_ID = 'worktree-1'
  const PICKED_KEY = 'github:9'
  const PICKED_REVIEW = {
    provider: 'github' as const,
    number: 9,
    title: 'Parent change',
    state: 'open' as const,
    url: 'https://github.com/acme/orca/pull/9',
    status: 'success' as const,
    updatedAt: '2026-05-17T00:00:00.000Z',
    mergeable: 'MERGEABLE' as const,
    headSha: 'picked-head'
  }

  function makePickedInput(overrides: Partial<RefreshInput> = {}): RefreshInput & {
    refreshSelectedReview: RefreshInput['reviewSelection']['refreshSelectedReview']
  } {
    const refreshSelectedReview = vi.fn(async () => null)
    const input: RefreshInput = {
      activeConnectionId: null,
      activeGitLabReview: null,
      activeWorktreeId: WORKTREE_ID,
      activeWorktreePath: null,
      activeWorktreePushTarget: null,
      asyncResultKeyRef: { current: 'cache::main::9' },
      branch: 'main',
      expireGitHubPRRefreshState: vi.fn(),
      fallbackGitHubPRNumber: null,
      fetchGitLabDetails: vi.fn(),
      fetchHostedReviewForBranch: vi.fn(),
      fetchPRChecks: vi.fn(async () => {
        refresh.calls.push('checks')
        return []
      }),
      fetchPRComments: vi.fn(async () => {
        refresh.calls.push('comments')
        return []
      }),
      fetchPRForBranch: vi.fn(async () => {
        refresh.calls.push('review')
        return null
      }),
      gitStatusSnapshot: null,
      isCurrentAsyncResult: (key) => input.asyncResultKeyRef.current === key,
      isFolder: false,
      isGitLabReviewContext: false,
      linkedAzureDevOpsPR: null,
      linkedBitbucketPR: null,
      linkedGiteaPR: null,
      linkedGitLabMR: null,
      linkedPR: 12,
      ownerCopyHostId: null,
      ownerTarget: { kind: 'local' },
      panelContextKey: 'repo-1::worktree-1::main',
      panelContextKeyRef: { current: 'repo-1::worktree-1::main' },
      pollIntervalRef: { current: 30_000 },
      pr: pickedPR,
      prCacheKey: 'cache',
      prNumber: 9,
      prevChecksRef: { current: '' },
      refreshInFlightRef: { current: false },
      refreshRequestKeyRef: { current: '' },
      repo: { id: 'repo-1', path: '/workspace/repo' } as NonNullable<RefreshInput['repo']>,
      reviewSelection: makeWorkspaceReviewSelection({
        isWorkspaceReview: false,
        selectedReview: PICKED_REVIEW,
        refreshSelectedReview
      }),
      setChecks: vi.fn(),
      setChecksLoading: vi.fn(),
      setComments: vi.fn(),
      setCommentsLoading: vi.fn(),
      setEligibilityRefreshNonce: vi.fn(),
      setGitStatusSnapshot: vi.fn(),
      setIsRefreshing: vi.fn(),
      showsPickedReview: true,
      updateWorktreeGitIdentity: vi.fn(),
      ...overrides
    }
    return { ...input, refreshSelectedReview }
  }

  beforeEach(() => {
    useAppStore.setState({
      workspaceReviewSelectionByWorktree: { [WORKTREE_ID]: PICKED_KEY }
    })
  })

  afterEach(() => {
    useAppStore.setState({ workspaceReviewSelectionByWorktree: {} })
  })

  it('re-reads the pick and never sends this worktree branch to GitHub', async () => {
    const input = makePickedInput()
    const { result } = renderHook(() => useChecksPanelManualRefresh(input))

    await act(async () => result.current.handleRefresh())

    expect(input.refreshSelectedReview).toHaveBeenCalledTimes(1)
    expect(input.fetchPRChecks).toHaveBeenCalledWith(
      '/workspace/repo',
      9,
      undefined,
      'picked-head',
      { owner: 'orca', repo: 'app', host: 'github.com' },
      expect.objectContaining({ force: true, repoId: 'repo-1' })
    )
    expect(input.fetchPRComments).toHaveBeenCalledWith(
      '/workspace/repo',
      9,
      expect.objectContaining({ force: true, headSha: 'picked-head' })
    )
    expect(input.fetchPRForBranch).not.toHaveBeenCalled()
    expect(input.fetchGitLabDetails).not.toHaveBeenCalled()
  })

  it('drops the rows when the review switched while the checks read was in flight', async () => {
    const setChecks = vi.fn()
    const setComments = vi.fn()
    const input = makePickedInput({ setChecks, setComments })
    input.fetchPRChecks = vi.fn(async () => {
      input.asyncResultKeyRef.current = 'a-different-review'
      const staleCheck: PRCheckDetail = {
        name: 'stale',
        status: 'completed',
        conclusion: 'success',
        url: null
      }
      return [staleCheck]
    })
    const { result } = renderHook(() => useChecksPanelManualRefresh(input))

    await act(async () => result.current.handleRefresh())

    expect(input.refreshSelectedReview).toHaveBeenCalledTimes(1)
    expect(setChecks).not.toHaveBeenCalled()
    expect(setComments).not.toHaveBeenCalled()
  })

  it('abandons the read when the review switched while the pick itself was being refreshed', async () => {
    const setChecks = vi.fn()
    const setComments = vi.fn()
    const setChecksLoading = vi.fn()
    const setCommentsLoading = vi.fn()
    const input = makePickedInput({
      reviewSelection: makeWorkspaceReviewSelection({
        isWorkspaceReview: false,
        selectedReview: PICKED_REVIEW,
        refreshSelectedReview: async () => {
          useAppStore.setState({ workspaceReviewSelectionByWorktree: {} })
          return null
        }
      }),
      setChecks,
      setComments,
      setChecksLoading,
      setCommentsLoading
    })
    const { result } = renderHook(() => useChecksPanelManualRefresh(input))

    await act(async () => result.current.handleRefresh())

    expect(input.fetchPRChecks).not.toHaveBeenCalled()
    expect(input.fetchPRComments).not.toHaveBeenCalled()
    expect(setChecks).not.toHaveBeenCalled()
    expect(setComments).not.toHaveBeenCalled()
    expect(setChecksLoading).not.toHaveBeenCalled()
    expect(setCommentsLoading).not.toHaveBeenCalled()
    expect(input.asyncResultKeyRef.current).toBe('cache::main::9')
    expect(input.refreshInFlightRef.current).toBe(false)
    expect(input.setIsRefreshing).toHaveBeenLastCalledWith(false)
  })

  it('drops the rows when the review switched after the result key was claimed', async () => {
    const setChecks = vi.fn()
    const setComments = vi.fn()
    const input = makePickedInput({ setChecks, setComments })
    input.fetchPRChecks = vi.fn(async () => {
      useAppStore.setState({ workspaceReviewSelectionByWorktree: {} })
      const staleCheck: PRCheckDetail = {
        name: 'stale',
        status: 'completed',
        conclusion: 'success',
        url: null
      }
      return [staleCheck]
    })
    const { result } = renderHook(() => useChecksPanelManualRefresh(input))

    await act(async () => result.current.handleRefresh())

    expect(input.refreshSelectedReview).toHaveBeenCalledTimes(1)
    expect(setChecks).not.toHaveBeenCalled()
    expect(setComments).not.toHaveBeenCalled()
  })

  it('reads a picked merge request through the GitLab details path, never through GitHub checks', async () => {
    const gitLabReview = {
      provider: 'gitlab' as const,
      number: 7,
      title: 'Parent change',
      state: 'open' as const,
      url: 'https://gitlab.invalid/acme/orca/-/merge_requests/7',
      status: 'pending' as const,
      updatedAt: '2026-05-17T00:00:00.000Z',
      mergeable: 'MERGEABLE' as const,
      headSha: 'mr-head'
    }
    useAppStore.setState({
      workspaceReviewSelectionByWorktree: { [WORKTREE_ID]: 'gitlab:7' }
    })
    const input = makePickedInput({
      activeGitLabReview: gitLabReview,
      isGitLabReviewContext: true,
      pr: null,
      prNumber: null,
      reviewSelection: makeWorkspaceReviewSelection({
        isWorkspaceReview: false,
        selectedReview: gitLabReview,
        refreshSelectedReview: async () => gitLabReview
      })
    })
    const { result } = renderHook(() => useChecksPanelManualRefresh(input))

    await act(async () => result.current.handleRefresh())

    expect(input.fetchPRChecks).not.toHaveBeenCalled()
    expect(input.fetchPRComments).not.toHaveBeenCalled()
    expect(input.fetchGitLabDetails).toHaveBeenCalledWith(
      expect.objectContaining({ mrNumberOverride: 7, headShaOverride: 'mr-head' })
    )
  })
})
