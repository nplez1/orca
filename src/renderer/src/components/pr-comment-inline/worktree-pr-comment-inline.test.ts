import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import type { Repo } from '../../../../shared/repo-types'
import type { PRComment } from '../../../../shared/github/comment-types'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { getGitHubPRCacheKey, getGitHubRepoCacheKey } from '@/store/slices/github-cache-key'
import { prCommentsCacheSuffix } from '@/store/github/cache-identity'
import type { AppState } from '@/store/types'
import {
  buildPRCommentInlineFromComments,
  deriveWorktreePRCommentInline
} from './worktree-pr-comment-inline'

const HEAD_SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'
const OTHER_SHA = 'f1e2d3c4b5a69788796a5b4c3d2e1f0f1e2d3c4b'

function comment(overrides: Partial<PRComment>): PRComment {
  return {
    id: overrides.id ?? 1,
    author: 'reviewer',
    authorAvatarUrl: '',
    body: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    url: 'https://example.test/comment',
    ...overrides
  }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the derivation only reads id/path/connectionId/executionHostId; a full Repo requires dozens of inert fields.
const repo = {
  id: 'repo-1',
  path: '/repo',
  connectionId: null,
  executionHostId: null
} as Repo
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only branch and head (from GitWorktreeInfo) are read; the rest of Worktree is inert here.
const worktree = {
  id: 'repo-1::/repo',
  repoId: 'repo-1',
  branch: 'feature/review',
  head: HEAD_SHA
} as Worktree

function buildState(overrides: {
  comments?: PRComment[]
  commentsHeadSha?: string | null
  prHeadSha?: string
  worktreeHead?: string
}): Pick<AppState, 'worktreesByRepo' | 'repos' | 'settings' | 'prCache' | 'commentsCache'> {
  const settings = createGlobalSettingsFixture()
  const prCacheKey = getGitHubPRCacheKey(
    repo.path,
    repo.id,
    'feature/review',
    settings,
    null,
    null,
    true
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the derivation reads only number/headSha/prRepo, which are set above.
  const pr = {
    number: 42,
    title: 'Review me',
    state: 'open',
    url: 'https://example.test/pr/42',
    checksStatus: 'success',
    updatedAt: '2026-01-01T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    headSha: overrides.prHeadSha ?? HEAD_SHA
  } as PRInfo
  const commentsCacheKey = getGitHubRepoCacheKey(
    repo.path,
    repo.id,
    prCommentsCacheSuffix(pr.number, pr.prRepo),
    settings,
    null,
    null,
    true
  )
  return {
    worktreesByRepo: {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: spreading a partial Worktree is how a fixture overrides one field without listing the rest.
      'repo-1': [{ ...worktree, head: overrides.worktreeHead ?? HEAD_SHA } as Worktree]
    },
    repos: [repo],
    settings,
    prCache: { [prCacheKey]: { data: pr, fetchedAt: 1 } },
    commentsCache: {
      [commentsCacheKey]: {
        data: overrides.comments ?? [comment({ id: 1, path: 'src/a.ts', line: 12 })],
        fetchedAt: 1,
        headSha:
          overrides.commentsHeadSha === undefined
            ? HEAD_SHA
            : (overrides.commentsHeadSha ?? undefined)
      }
    }
  }
}

describe('buildPRCommentInlineFromComments', () => {
  it('exposes the review identity the mutations need and groups threads by path', () => {
    const review = buildPRCommentInlineFromComments({
      repoPath: '/repo',
      repoId: 'repo-1',
      prNumber: 42,
      prRepo: null,
      comments: [
        comment({ id: 1, threadId: 't1', path: 'src/a.ts', line: 12 }),
        comment({ id: 2, threadId: 't1', path: 'src/a.ts', line: 12 }),
        comment({ id: 3, threadId: 't2', path: 'src/b.ts', line: 4 })
      ],
      enabled: true,
      blocker: null,
      commentsHeadSha: HEAD_SHA
    })

    expect(review.scope).toBe('github-pr:repo-1:42')
    expect(review.reviewTarget).toEqual({
      repoPath: '/repo',
      repoId: 'repo-1',
      prNumber: 42,
      prRepo: null
    })
    expect([...(review.inlineThreadsByPath?.keys() ?? [])].sort()).toEqual(['src/a.ts', 'src/b.ts'])
    expect(review.inlineThreadsByPath?.get('src/a.ts')?.[0].replies).toHaveLength(1)
  })

  it('keeps navigating threads but withholds inline placement when the caller reports a blocker', () => {
    const review = buildPRCommentInlineFromComments({
      repoPath: '/repo',
      repoId: 'repo-1',
      prNumber: 42,
      prRepo: null,
      comments: [comment({ id: 1, threadId: 't1', path: 'src/a.ts', line: 12 })],
      enabled: true,
      blocker: { kind: 'unverified-head' },
      commentsHeadSha: null
    })

    expect(review.inlineThreadsByPath).toBeNull()
    expect(review.threadsByPath?.get('src/a.ts')).toHaveLength(1)
  })
})

describe('deriveWorktreePRCommentInline', () => {
  it('draws threads once the checkout is the head the comments were fetched against', () => {
    const review = deriveWorktreePRCommentInline(buildState({}), worktree.id)

    expect(review.blocker).toBeNull()
    expect(review.prNumber).toBe(42)
    expect(review.inlineThreadsByPath?.get('src/a.ts')).toHaveLength(1)
  })

  it('withholds placement when the checkout has moved off the reviewed head', () => {
    const review = deriveWorktreePRCommentInline(
      buildState({ worktreeHead: OTHER_SHA }),
      worktree.id
    )

    expect(review.blocker).toEqual({
      kind: 'head-mismatch',
      worktreeHeadOid: OTHER_SHA,
      commentsHeadSha: HEAD_SHA,
      prHeadSha: HEAD_SHA
    })
    expect(review.inlineThreadsByPath).toBeNull()
    expect(review.threadsByPath?.get('src/a.ts')).toHaveLength(1)
  })

  it('withholds placement when the cached comments never recorded a head', () => {
    const review = deriveWorktreePRCommentInline(buildState({ commentsHeadSha: null }), worktree.id)

    expect(review.blocker).toEqual({ kind: 'unverified-head' })
    expect(review.inlineThreadsByPath).toBeNull()
  })

  it('withholds placement while the pull request head has moved past the fetched comments', () => {
    // The checkout and the PR agree on OTHER_SHA, but the cached comments still describe HEAD_SHA,
    // which is exactly the window a head-keyed checks cache would otherwise paper over.
    const review = deriveWorktreePRCommentInline(
      buildState({ commentsHeadSha: HEAD_SHA, prHeadSha: OTHER_SHA, worktreeHead: OTHER_SHA }),
      worktree.id
    )

    expect(review.blocker).toEqual({
      kind: 'head-mismatch',
      worktreeHeadOid: OTHER_SHA,
      commentsHeadSha: HEAD_SHA,
      prHeadSha: OTHER_SHA
    })
  })

  it('withholds placement when the checkout is left on the revision the comments describe but the pull request moved on', () => {
    const review = deriveWorktreePRCommentInline(
      buildState({ commentsHeadSha: HEAD_SHA, prHeadSha: OTHER_SHA, worktreeHead: HEAD_SHA }),
      worktree.id
    )

    expect(review.blocker).toEqual({
      kind: 'head-mismatch',
      worktreeHeadOid: HEAD_SHA,
      commentsHeadSha: HEAD_SHA,
      prHeadSha: OTHER_SHA
    })
    expect(review.inlineThreadsByPath).toBeNull()
  })

  it('reports no review for an unknown worktree or an unmatched branch', () => {
    const state = buildState({})
    expect(deriveWorktreePRCommentInline(state, 'missing').scope).toBeNull()
    expect(deriveWorktreePRCommentInline(state, null).scope).toBeNull()
  })
})
