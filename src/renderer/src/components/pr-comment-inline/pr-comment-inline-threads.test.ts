import { describe, expect, it } from 'vitest'
import type { PRComment } from '../../../../shared/github/comment-types'
import {
  buildPRCommentInlineThreads,
  commitOidsMatch,
  getPRCommentInlineId,
  groupPRCommentInlineThreadsByPath,
  resolvePRCommentInlineBlocker
} from './pr-comment-inline-threads'

function comment(overrides: Partial<PRComment>): PRComment {
  return {
    id: overrides.id ?? 1,
    author: 'user',
    authorAvatarUrl: '',
    body: '',
    createdAt: '',
    url: '',
    ...overrides
  }
}

describe('buildPRCommentInlineThreads', () => {
  it('groups replies under their root and orders threads by line', () => {
    const threads = buildPRCommentInlineThreads([
      comment({ id: 1, threadId: 't1', path: 'src/a.ts', line: 40, startLine: 38 }),
      comment({ id: 2, threadId: 't1', path: 'src/a.ts', line: 40 }),
      comment({ id: 3, threadId: 't2', path: 'src/a.ts', line: 12, isResolved: true })
    ])

    expect(threads.map((thread) => thread.id)).toEqual([
      getPRCommentInlineId(3),
      getPRCommentInlineId(1)
    ])
    expect(threads[1]).toMatchObject({
      threadId: 't1',
      path: 'src/a.ts',
      line: 40,
      startLine: 38,
      isResolved: false,
      root: { id: 1 },
      replies: [{ id: 2 }]
    })
    expect(threads[0].isResolved).toBe(true)
  })

  it('drops outdated, path-less and line-less comments', () => {
    const threads = buildPRCommentInlineThreads([
      comment({ id: 1, threadId: 't1', path: 'src/a.ts', line: 5, isOutdated: true }),
      comment({ id: 2, threadId: 't2', line: 5 }),
      comment({ id: 3, threadId: 't3', path: 'src/a.ts' })
    ])

    expect(threads).toEqual([])
  })

  it('keeps a review comment that arrived without a thread, minus reply and resolve', () => {
    const threads = buildPRCommentInlineThreads([
      comment({ id: 7, path: 'src/a.ts', line: 3, startLine: 3 })
    ])

    expect(threads).toHaveLength(1)
    expect(threads[0].threadId).toBeUndefined()
    expect(threads[0].replies).toEqual([])
  })
})

describe('groupPRCommentInlineThreadsByPath', () => {
  it('buckets threads by file path', () => {
    const threads = buildPRCommentInlineThreads([
      comment({ id: 1, threadId: 't1', path: 'src/a.ts', line: 1 }),
      comment({ id: 2, threadId: 't2', path: 'src/b.ts', line: 2 }),
      comment({ id: 3, threadId: 't3', path: 'src/a.ts', line: 9 })
    ])

    const byPath = groupPRCommentInlineThreadsByPath(threads)

    expect([...byPath.keys()]).toEqual(['src/a.ts', 'src/b.ts'])
    expect(byPath.get('src/a.ts')?.map((thread) => thread.line)).toEqual([1, 9])
  })
})

describe('commitOidsMatch', () => {
  it('matches identical ids regardless of case or padding', () => {
    expect(commitOidsMatch(' ABC1234 ', 'abc1234')).toBe(true)
  })

  it('matches an abbreviated id against the full one once it is unambiguous', () => {
    expect(commitOidsMatch('a1b2c3d', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0')).toBe(true)
  })

  it('rejects a short form too brief to identify a commit', () => {
    expect(commitOidsMatch('a1b2c3', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0')).toBe(false)
  })

  it('rejects different commits and missing ids', () => {
    expect(commitOidsMatch('a1b2c3d', 'f1e2d3c')).toBe(false)
    expect(commitOidsMatch('', 'abc1234')).toBe(false)
    expect(commitOidsMatch(null, undefined)).toBe(false)
  })
})

describe('resolvePRCommentInlineBlocker', () => {
  const matching = {
    enabled: true,
    worktreeHeadOid: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
    commentsHeadSha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'
  }

  it('clears placement when the worktree head is the head the comments were fetched against', () => {
    expect(resolvePRCommentInlineBlocker(matching)).toBeNull()
  })

  it('clears an abbreviated worktree head against the full sha', () => {
    expect(resolvePRCommentInlineBlocker({ ...matching, worktreeHeadOid: 'a1b2c3d' })).toBeNull()
  })

  it('reports a mismatch rather than guessing a line', () => {
    expect(
      resolvePRCommentInlineBlocker({
        ...matching,
        worktreeHeadOid: 'f1e2d3c4b5a69788796a5b4c3d2e1f0f1e2d3c4b'
      })
    ).toEqual({
      kind: 'head-mismatch',
      worktreeHeadOid: 'f1e2d3c4b5a69788796a5b4c3d2e1f0f1e2d3c4b',
      commentsHeadSha: matching.commentsHeadSha
    })
  })

  it('blocks placement when either head is unknown', () => {
    expect(resolvePRCommentInlineBlocker({ ...matching, worktreeHeadOid: null })).toEqual({
      kind: 'unverified-head'
    })
    expect(resolvePRCommentInlineBlocker({ ...matching, commentsHeadSha: undefined })).toEqual({
      kind: 'unverified-head'
    })
  })

  it('does not warn when the user turned inline comments off', () => {
    expect(
      resolvePRCommentInlineBlocker({ ...matching, enabled: false, worktreeHeadOid: 'other1' })
    ).toBeNull()
  })
})
