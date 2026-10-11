// @vitest-environment happy-dom

globalThis.IS_REACT_ACT_ENVIRONMENT = true

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flush, mountProbe, unmountProbes } from '../source-control-hook-test-harness'
import { useChecksPanelReviewData } from './use-checks-panel-review-data'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type { PRInfo } from '../../../../../shared/github/pull-request-types'
import type { Repo } from '../../../../../shared/repo-types'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'orca',
  badgeColor: '#000000',
  addedAt: 1
}
const prBase: PRInfo = {
  number: 42,
  title: 'Verdicts',
  state: 'open',
  url: 'https://github.com/acme/orca/pull/42',
  checksStatus: 'success',
  mergeable: 'MERGEABLE',
  headSha: 'head-a',
  reviewDecision: 'REVIEW_REQUIRED',
  updatedAt: '2026-05-14T00:00:00Z'
}

const fetchPRComments = vi.fn<
  (repoPath: string, prNumber: number, options?: { force?: boolean }) => Promise<PRComment[]>
>(async () => [])
const fetchPRCheckDetails = vi.fn<() => Promise<null>>(async () => null)
const setComments = vi.fn()
const setCommentsError = vi.fn()
const setCommentsLoading = vi.fn()
// Why stable identities: an unstable callback would re-run the effect for a reason that has
// nothing to do with the review state this test is about.
const isCurrentAsyncResult = (): boolean => true

function Probe({ pr, prCacheKey }: { pr: PRInfo; prCacheKey: string }): null {
  useChecksPanelReviewData({
    activeGitLabReview: null,
    branch: 'feature',
    fetchPRCheckDetails,
    fetchPRComments,
    gitLabProjectRefRef: { current: null },
    isCurrentAsyncResult,
    isPanelVisible: true,
    pr,
    prCacheKey,
    prNumber: pr.number,
    repo,
    activeWorktree: null,
    setComments,
    setCommentsError,
    setCommentsLoading
  })
  return null
}

const lastForce = (): boolean | undefined => fetchPRComments.mock.calls.at(-1)?.[2]?.force

beforeEach(() => {
  fetchPRComments.mockClear()
  setComments.mockClear()
  setCommentsLoading.mockClear()
  vi.stubGlobal('api', {
    gh: { onWorkItemMutated: () => () => {} }
  })
})

afterEach(() => {
  unmountProbes()
  vi.unstubAllGlobals()
})

describe('checks panel review data refresh', () => {
  it('does not bypass the comments cache for a first read or an ordinary re-render', async () => {
    const root = await mountProbe(<Probe pr={prBase} prCacheKey="repo-1::feature" />)
    await flush()

    expect(fetchPRComments).toHaveBeenCalledTimes(1)
    expect(lastForce()).toBe(false)

    // Same PR, same review state: nothing to re-read.
    await act(async () => {
      await root.render(<Probe pr={{ ...prBase }} prCacheKey="repo-1::feature" />)
    })
    await flush()
    expect(fetchPRComments).toHaveBeenCalledTimes(1)
  })

  it('re-reads past the comments cache when the PR review state moves', async () => {
    const root = await mountProbe(<Probe pr={prBase} prCacheKey="repo-1::feature" />)
    await flush()

    // An approval landing while the panel is open: `reviewDecision` and `updatedAt` both move.
    await act(async () => {
      await root.render(
        <Probe
          pr={{
            ...prBase,
            reviewDecision: 'APPROVED',
            updatedAt: '2026-05-14T01:00:00Z'
          }}
          prCacheKey="repo-1::feature"
        />
      )
    })
    await flush()

    expect(fetchPRComments).toHaveBeenCalledTimes(2)
    expect(lastForce()).toBe(true)
  })

  it('does not force on the first read of a different PR', async () => {
    const root = await mountProbe(<Probe pr={prBase} prCacheKey="repo-1::feature" />)
    await flush()

    // A new prCacheKey changes the revision too, and switching PRs is not a reason to skip the
    // per-PR comments cache.
    await act(async () => {
      await root.render(
        <Probe
          pr={{ ...prBase, number: 43, updatedAt: '2026-05-15T00:00:00Z' }}
          prCacheKey="repo-1::other"
        />
      )
    })
    await flush()

    expect(fetchPRComments).toHaveBeenCalledTimes(2)
    expect(lastForce()).toBe(false)
  })
})
