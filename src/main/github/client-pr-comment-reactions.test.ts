import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GitHubEnterpriseRepositoryModule from './github-enterprise-repository'

const { clientMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./client-test-mocks')
  return { clientMocks: moduleMocks.createGitHubClientMocks(), moduleMocks }
})

vi.mock('./gh-utils', () => moduleMocks.ghUtilsModuleMock(clientMocks))
vi.mock('../git/runner', () => moduleMocks.gitRunnerModuleMock(clientMocks))
vi.mock('./local-git-config-signature', () =>
  moduleMocks.localGitConfigSignatureModuleMock(clientMocks)
)
vi.mock('./github-enterprise-repository', async (importOriginal) =>
  moduleMocks.githubEnterpriseRepositoryModuleMock(
    await importOriginal<typeof GitHubEnterpriseRepositoryModule>()
  )
)
vi.mock('./rate-limit', () => moduleMocks.rateLimitModuleMock(clientMocks))
vi.mock('./github-api-repository', async (importOriginal) =>
  moduleMocks.githubApiRepositoryModuleMock(
    clientMocks,
    await importOriginal<typeof GithubApiRepositoryModule>()
  )
)

import { getPRComments } from './client/fetch/get-pr-comments'
import { setPRCommentReaction } from './client/update/pr-comment-reaction'
import { resetGraphQLRateLimitGuardMocks } from './client-test-harness'
import type { RateLimitGuardResult } from './client-test-mocks'

const { ghExecFileAsyncMock, getOwnerRepoMock, rateLimitGuardMock, noteRateLimitSpendMock } =
  clientMocks

describe('GitHub GraphQL rate-limit guard', () => {
  beforeEach(() => {
    resetGraphQLRateLimitGuardMocks(clientMocks)
  })

  afterEach(() => vi.restoreAllMocks())

  it('skips PR review-thread GraphQL fetch while preserving REST comments', async () => {
    rateLimitGuardMock.mockImplementation(((bucket: string) =>
      bucket === 'graphql'
        ? { blocked: true, remaining: 4, limit: 5000, resetAt: 1_800_000_000 }
        : { blocked: false }) as () => RateLimitGuardResult)
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            id: 10,
            user: { login: 'octo', avatar_url: 'https://avatar', type: 'User' },
            body: 'top-level',
            created_at: '2026-04-01T00:00:00Z',
            html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-10'
          }
        ])
      })
      .mockResolvedValueOnce({ stdout: '[]' })

    const comments = await getPRComments('/repo-root', 7)

    expect(comments).toHaveLength(1)
    expect(comments[0].body).toBe('top-level')
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(ghExecFileAsyncMock.mock.calls.some((call) => call[0][1] === 'graphql')).toBe(false)
    expect(noteRateLimitSpendMock).not.toHaveBeenCalledWith('graphql')
  })

  it('maps review summary reaction subjects from GraphQL', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: { nodes: [] },
                comments: { nodes: [] },
                reviews: {
                  nodes: [
                    {
                      id: 'PRR_44',
                      databaseId: 44,
                      author: {
                        __typename: 'Bot',
                        login: 'coderabbitai',
                        avatarUrl: 'https://avatar'
                      },
                      body: 'Automated review summary',
                      createdAt: '2026-04-01T00:00:00Z',
                      url: 'https://github.com/acme/widgets/pull/7#pullrequestreview-44',
                      reactionGroups: [
                        {
                          content: 'ROCKET',
                          viewerHasReacted: true,
                          reactors: { totalCount: 2 }
                        }
                      ]
                    }
                  ]
                }
              }
            }
          }
        })
      })
      .mockResolvedValueOnce({ stdout: '[]' })
      .mockResolvedValueOnce({ stdout: '[]' })

    await expect(getPRComments('/repo-root', 7)).resolves.toEqual([
      expect.objectContaining({
        id: 44,
        reactionSubjectId: 'PRR_44',
        isBot: true,
        reactions: [{ content: 'rocket', count: 2, viewerHasReacted: true }]
      })
    ])
    expect(ghExecFileAsyncMock.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([expect.stringContaining('reviews(last: 100)')])
    )
  })

  it('uses explicit PR repo for comments when a fork PR is discovered', async () => {
    rateLimitGuardMock.mockImplementation(((bucket: string) =>
      bucket === 'graphql'
        ? { blocked: true, remaining: 4, limit: 5000, resetAt: 1_800_000_000 }
        : { blocked: false }) as () => RateLimitGuardResult)
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            id: 10,
            user: { login: 'octo', avatar_url: 'https://avatar', type: 'User' },
            body: 'top-level',
            created_at: '2026-04-01T00:00:00Z',
            html_url: 'https://github.com/stablyai/orca/pull/7#issuecomment-10'
          }
        ])
      })
      .mockResolvedValueOnce({ stdout: '[]' })

    await getPRComments(
      '/repo-root',
      7,
      { prRepo: { owner: 'stablyai', repo: 'orca', host: 'github.com' } },
      undefined
    )

    expect(getOwnerRepoMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['api', '--cache', '60s', 'repos/stablyai/orca/issues/7/comments?per_page=100'],
      { cwd: '/repo-root', host: 'github.com' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['api', '--cache', '60s', 'repos/stablyai/orca/pulls/7/reviews?per_page=100'],
      { cwd: '/repo-root', host: 'github.com' }
    )
  })

  it('returns GraphQL reaction subjects and viewer state for PR comments', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                comments: {
                  nodes: [
                    {
                      id: 'IC_1',
                      databaseId: 10,
                      author: { login: 'octo', avatarUrl: '', __typename: 'User' },
                      body: 'Issue comment',
                      createdAt: '2026-04-01T00:00:00Z',
                      url: 'https://example.test/issue-comment',
                      reactionGroups: [
                        {
                          content: 'THUMBS_UP',
                          viewerHasReacted: true,
                          reactors: { totalCount: 2 }
                        }
                      ]
                    }
                  ]
                },
                reviewThreads: {
                  nodes: [
                    {
                      id: 'PRRT_1',
                      isResolved: false,
                      line: 4,
                      startLine: null,
                      originalLine: 4,
                      originalStartLine: null,
                      comments: {
                        nodes: [
                          {
                            id: 'PRRC_1',
                            databaseId: 11,
                            author: { login: 'reviewer', avatarUrl: '', __typename: 'User' },
                            body: 'Inline comment',
                            createdAt: '2026-04-01T00:01:00Z',
                            url: 'https://example.test/review-comment',
                            path: 'src/app.ts',
                            reactionGroups: [
                              {
                                content: 'EYES',
                                viewerHasReacted: false,
                                reactors: { totalCount: 1 }
                              }
                            ]
                          }
                        ]
                      }
                    }
                  ]
                }
              }
            }
          }
        })
      })
      .mockResolvedValueOnce({ stdout: '[]' })
      .mockResolvedValueOnce({ stdout: '[]' })

    const comments = await getPRComments('/repo-root', 7, {
      prRepo: { owner: 'acme', repo: 'widgets', host: 'github.com' }
    })

    expect(comments).toEqual([
      expect.objectContaining({
        id: 10,
        reactionSubjectId: 'IC_1',
        reactions: [{ content: '+1', count: 2, viewerHasReacted: true }]
      }),
      expect.objectContaining({
        id: 11,
        reactionSubjectId: 'PRRC_1',
        reactions: [{ content: 'eyes', count: 1, viewerHasReacted: false }]
      })
    ])
  })

  it('keeps a bodyless approval only for a caller that renders verdicts', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: { nodes: [] },
                comments: { nodes: [] },
                reviews: {
                  nodes: [
                    {
                      id: 'PRR_45',
                      databaseId: 45,
                      author: { __typename: 'User', login: 'ana', avatarUrl: 'https://avatar' },
                      body: '',
                      state: 'APPROVED',
                      createdAt: '2026-04-02T00:00:00Z',
                      url: 'https://github.com/acme/widgets/pull/7#pullrequestreview-45'
                    },
                    {
                      id: 'PRR_46',
                      databaseId: null,
                      author: { __typename: 'User', login: 'kim', avatarUrl: 'https://avatar' },
                      body: '',
                      state: 'APPROVED',
                      createdAt: '2026-04-02T00:00:01Z',
                      url: 'https://github.com/acme/widgets/pull/7#pullrequestreview-46'
                    },
                    {
                      id: 'PRR_47',
                      databaseId: 47,
                      author: { __typename: 'User', login: 'jo', avatarUrl: 'https://avatar' },
                      body: '',
                      state: 'COMMENTED',
                      createdAt: '2026-04-02T00:00:02Z',
                      url: 'https://github.com/acme/widgets/pull/7#pullrequestreview-47'
                    },
                    {
                      id: 'PRR_48',
                      databaseId: 48,
                      author: { __typename: 'User', login: 'mo', avatarUrl: 'https://avatar' },
                      body: '',
                      state: 'SOMETHING_ELSE',
                      createdAt: '2026-04-02T00:00:03Z',
                      url: 'https://github.com/acme/widgets/pull/7#pullrequestreview-48'
                    }
                  ]
                }
              }
            }
          }
        })
      })
      .mockResolvedValueOnce({ stdout: '[]' })
      .mockResolvedValueOnce({ stdout: '[]' })

    await expect(getPRComments('/repo-root', 7, { includeReviewVerdicts: true })).resolves.toEqual([
      // Only a bodyless *decision* survives here: a review with no body and no decision is how
      // GitHub submits inline comments, and a review with no numeric id cannot be anchored at all.
      expect.objectContaining({ id: 45, body: '', reviewState: 'APPROVED' })
    ])
    expect(ghExecFileAsyncMock.mock.calls[0]?.[0]?.join(' ')).toContain('state')
    // Why `last` in the selection: a 100-review cap has to keep the newest submissions.
    expect(ghExecFileAsyncMock.mock.calls[0]?.[0]?.join(' ')).toContain('reviews(last: 100)')
  })

  it('drops every bodyless review for a caller that does not ask for verdicts', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: { nodes: [] },
                comments: { nodes: [] },
                reviews: {
                  nodes: [
                    {
                      id: 'PRR_45',
                      databaseId: 45,
                      author: { __typename: 'User', login: 'ana', avatarUrl: 'https://avatar' },
                      body: '',
                      state: 'APPROVED',
                      createdAt: '2026-04-02T00:00:00Z',
                      url: 'https://github.com/acme/widgets/pull/7#pullrequestreview-45'
                    }
                  ]
                }
              }
            }
          }
        })
      })
      .mockResolvedValueOnce({ stdout: '[]' })
      .mockResolvedValueOnce({ stdout: '[]' })

    // Why the default stays: the PR page, the item dialog and mobile read this same payload as
    // comments, where a bodyless approval would be an empty card.
    await expect(getPRComments('/repo-root', 7)).resolves.toEqual([])
  })

  it('maps review state from the REST fallback when GraphQL has no pull request', async () => {
    rateLimitGuardMock.mockImplementation(((bucket: string) =>
      bucket === 'graphql'
        ? { blocked: true, remaining: 4, limit: 5000, resetAt: 1_800_000_000 }
        : { blocked: false }) as () => RateLimitGuardResult)
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' }).mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          id: 55,
          user: { login: 'ana', avatar_url: 'https://avatar', type: 'User' },
          body: '',
          state: 'CHANGES_REQUESTED',
          submitted_at: '2026-04-02T00:00:00Z',
          html_url: 'https://github.com/acme/widgets/pull/7#pullrequestreview-55'
        },
        {
          id: 56,
          user: { login: 'sam', avatar_url: 'https://avatar', type: 'User' },
          body: 'Nit: rename this.',
          state: 'NOT_A_REVIEW_STATE',
          submitted_at: '2026-04-02T00:00:01Z',
          html_url: 'https://github.com/acme/widgets/pull/7#pullrequestreview-56'
        }
      ])
    })

    await expect(getPRComments('/repo-root', 7, { includeReviewVerdicts: true })).resolves.toEqual([
      expect.objectContaining({ id: 55, body: '', reviewState: 'CHANGES_REQUESTED' }),
      // An unmapped host spelling reads as "no verdict", never as a verdict to guess at.
      expect.objectContaining({ id: 56, reviewState: undefined })
    ])
  })

  it('applies the same keep-rule on the REST fallback, flag or no flag', async () => {
    const reviews = [
      {
        id: 55,
        user: { login: 'ana', avatar_url: 'https://avatar', type: 'User' },
        body: '',
        state: 'CHANGES_REQUESTED',
        submitted_at: '2026-04-02T00:00:00Z',
        html_url: 'https://github.com/acme/widgets/pull/7#pullrequestreview-55'
      },
      {
        id: 57,
        user: { login: 'jo', avatar_url: 'https://avatar', type: 'User' },
        body: '',
        state: 'COMMENTED',
        submitted_at: '2026-04-02T00:00:01Z',
        html_url: 'https://github.com/acme/widgets/pull/7#pullrequestreview-57'
      },
      {
        id: 58,
        user: { login: 'mo', avatar_url: 'https://avatar', type: 'User' },
        body: '',
        state: 'SOMETHING_ELSE',
        submitted_at: '2026-04-02T00:00:02Z',
        html_url: 'https://github.com/acme/widgets/pull/7#pullrequestreview-58'
      }
    ]
    const arrange = (): void => {
      rateLimitGuardMock.mockImplementation(((bucket: string) =>
        bucket === 'graphql'
          ? { blocked: true, remaining: 4, limit: 5000, resetAt: 1_800_000_000 }
          : { blocked: false }) as () => RateLimitGuardResult)
      getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
      ghExecFileAsyncMock
        .mockResolvedValueOnce({ stdout: '[]' })
        .mockResolvedValueOnce({ stdout: JSON.stringify(reviews) })
    }

    arrange()
    // The bodyless decision is the only entry a verdict renderer needs; the bodyless neutral
    // review and the unrecognised state are noise on both sides of the rule.
    await expect(getPRComments('/repo-root', 7, { includeReviewVerdicts: true })).resolves.toEqual([
      expect.objectContaining({ id: 55, reviewState: 'CHANGES_REQUESTED' })
    ])

    ghExecFileAsyncMock.mockReset()
    rateLimitGuardMock.mockReset()
    arrange()
    await expect(getPRComments('/repo-root', 7)).resolves.toEqual([])
  })

  it('adds and removes PR comment reactions through GraphQL', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValue({ stdout: '{}', stderr: '' })

    await expect(setPRCommentReaction('/repo-root', 'IC_1', '+1', true)).resolves.toBe(true)
    await expect(setPRCommentReaction('/repo-root', 'PRRC_1', 'eyes', false)).resolves.toBe(true)

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      expect.arrayContaining(['subjectId=IC_1', 'content=THUMBS_UP']),
      expect.any(Object)
    )
    expect(ghExecFileAsyncMock.mock.calls[0]?.[0].join(' ')).toContain('addReaction')
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining(['subjectId=PRRC_1', 'content=EYES']),
      expect.any(Object)
    )
    expect(ghExecFileAsyncMock.mock.calls[1]?.[0].join(' ')).toContain('removeReaction')
    expect(noteRateLimitSpendMock).toHaveBeenCalledTimes(2)
  })
})
