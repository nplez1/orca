// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { WorkspaceAttachment } from '../../../../shared/worktree/types'
import { makeRepo } from '../sidebar/worktree-list-lineage-card-test-fixtures'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'

const store = vi.hoisted(() => {
  const selections: Record<string, string> = {}
  return {
    selections,
    selectWorkspaceReview: vi.fn(),
    fetchHostedReviewForBranch: vi.fn(async () => null)
  }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      workspaceReviewSelectionByWorktree: store.selections,
      selectWorkspaceReview: store.selectWorkspaceReview,
      fetchHostedReviewForBranch: store.fetchHostedReviewForBranch,
      hostedReviewCache: {}
    })
}))

vi.mock('@/lib/provider-runtime-context', () => ({
  getProviderRuntimeContextKey: () => 'runtime'
}))

vi.mock('@/runtime/runtime-environment-revision', () => ({
  getRuntimeEnvironmentRevision: () => 0
}))

vi.mock('../sidebar/workspace-reference-review-source', () => ({
  canReadWorkspaceReferenceReview: () => true
}))

import { useWorkspaceReviewSelection } from './use-workspace-review-selection'

function makeReview(overrides: Partial<WorkspaceAttachment> = {}): WorkspaceAttachment {
  return {
    provider: 'github',
    type: 'pr',
    number: 12,
    title: 'Add the thing',
    url: 'https://github.com/acme/orca/pull/12',
    ...overrides
  }
}

function makeActiveReview(overrides: Partial<HostedReviewInfo> = {}): HostedReviewInfo {
  return {
    provider: 'github',
    number: 12,
    title: 'Add the thing',
    state: 'open',
    url: 'https://github.com/acme/orca/pull/12',
    status: 'success',
    updatedAt: '2026-05-17T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    ...overrides
  }
}

const worktree = makeWorktree({
  id: 'worktree-1',
  repoId: 'repo-1',
  branch: 'feature/multi-pr',
  linkedPR: 12,
  linkedItems: [
    makeReview(),
    makeReview({ number: 9, title: 'Parent change', url: 'https://github.com/acme/orca/pull/9' })
  ]
})

afterEach(() => {
  cleanup()
  store.selections = {}
  store.selectWorkspaceReview.mockReset()
  store.fetchHostedReviewForBranch.mockReset()
})

function renderSelection(activeReview: HostedReviewInfo | null = makeActiveReview()) {
  return renderHook(() =>
    useWorkspaceReviewSelection({
      activeReview,
      isVisible: true,
      repo: makeRepo(),
      worktree
    })
  )
}

describe('useWorkspaceReviewSelection', () => {
  it('leads with the workspace review and reports that more than one review exists', () => {
    const { result } = renderSelection()

    expect(result.current.entries.map((entry) => entry.key)).toEqual(['github:12', 'github:9'])
    expect(result.current.hasMultiple).toBe(true)
    expect(result.current.isWorkspaceReview).toBe(true)
    expect(result.current.selected?.key).toBe('github:12')
  })

  it('reads the stored pick for this worktree instead of the workspace review', () => {
    store.selections = { 'worktree-1': 'github:9' }

    const { result } = renderSelection()

    expect(result.current.selected?.key).toBe('github:9')
    expect(result.current.isWorkspaceReview).toBe(false)
  })

  it('stores a pick for another review and clears it when the workspace review is picked again', () => {
    const { result } = renderSelection()

    result.current.selectReview('github:9')
    expect(store.selectWorkspaceReview).toHaveBeenLastCalledWith('worktree-1', 'github:9')

    result.current.selectReview('github:12')
    expect(store.selectWorkspaceReview).toHaveBeenLastCalledWith('worktree-1', null)
  })

  it('reads a picked review through its own cache key rather than the branch entry', () => {
    store.selections = { 'worktree-1': 'github:9' }

    renderSelection()

    expect(store.fetchHostedReviewForBranch).toHaveBeenCalledTimes(1)
    expect(store.fetchHostedReviewForBranch).toHaveBeenCalledWith(
      '/tmp/lineage-order',
      'feature/multi-pr',
      expect.objectContaining({ linkedGitHubPR: 9, exactReviewKey: expect.any(String) })
    )
  })

  it('does not ask the host again for the workspace review the pane already fetched', () => {
    renderSelection()

    expect(store.fetchHostedReviewForBranch).not.toHaveBeenCalled()
  })

  it('never writes the shared selection on its own, even when the pick is this pane default', () => {
    // Why: the two panes resolve their default review from different async sources, so a stored key
    // that is the default in one is a pick in the other. Clearing here would let one pane wipe the
    // other's pick, which is the disagreement the shared selection exists to prevent.
    store.selections = { 'worktree-1': 'github:12' }

    const { result } = renderSelection()

    expect(result.current.isWorkspaceReview).toBe(true)
    expect(store.selectWorkspaceReview).not.toHaveBeenCalled()
  })

  it('hides a pick whose lookup has not answered yet, so the pane keeps the workspace review', () => {
    store.selections = { 'worktree-1': 'github:9' }

    const { result } = renderSelection()

    expect(result.current.selected?.key).toBe('github:9')
    expect(result.current.selectedReview).toBeNull()
  })
})
