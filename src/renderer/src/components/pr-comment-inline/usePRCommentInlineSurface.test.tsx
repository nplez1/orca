// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { PRComment } from '../../../../shared/github/comment-types'
import type { PRCommentInlineThread } from './pr-comment-inline-threads'
import { buildPRCommentInlineFromComments } from './worktree-pr-comment-inline'
import { usePRCommentInlineSurface } from './usePRCommentInlineSurface'

const OID = 'a'.repeat(40)
const SCOPE = 'github-pr:repo-1:42'

function thread(path: string, line: number): PRCommentInlineThread {
  const root: PRComment = {
    id: 1,
    author: 'reviewer',
    authorAvatarUrl: '',
    body: 'this line is wrong',
    createdAt: '2026-01-01T00:00:00.000Z',
    url: 'https://example.test/comment',
    path,
    line
  }
  return { id: `github-pr-comment:${root.id}`, path, line, isResolved: false, root, replies: [] }
}

function reviewWith(threadPath: string): ReturnType<typeof buildPRCommentInlineFromComments> {
  return buildPRCommentInlineFromComments({
    repoPath: '/repo',
    repoId: 'repo-1',
    prNumber: 42,
    prRepo: null,
    comments: [thread(threadPath, 12).root],
    enabled: true,
    blocker: null,
    commentsHeadSha: OID
  })
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('usePRCommentInlineSurface', () => {
  it('binds a file to the threads the provider files under its own path', () => {
    const { result } = renderHook(() =>
      usePRCommentInlineSurface(reviewWith('src/a.ts'), 'src/a.ts')
    )

    expect(result.current?.scope).toBe(SCOPE)
    expect(result.current?.threads).toHaveLength(1)
  })

  it('finds a pre-rename thread under the name the provider still uses', () => {
    // A renamed file is opened at its new path, but GitHub keeps an old thread on the old one.
    const { result } = renderHook(() =>
      usePRCommentInlineSurface(reviewWith('src/old.ts'), 'src/new.ts', 'src/old.ts')
    )

    expect(result.current?.threads).toHaveLength(1)
  })

  it('binds no threads when the file only matches on a path nobody claimed', () => {
    const { result } = renderHook(() =>
      usePRCommentInlineSurface(reviewWith('src/old.ts'), 'src/other.ts', 'src/also-not-it.ts')
    )

    expect(result.current?.threads).toBeNull()
  })

  it('reports every thread whatever the inline setting says, and leaves display to `enabled`', () => {
    const review = reviewWith('src/a.ts')
    const { result } = renderHook(() =>
      usePRCommentInlineSurface({ ...review, enabled: false }, 'src/a.ts')
    )

    expect(result.current?.enabled).toBe(false)
    expect(result.current?.threads).toHaveLength(1)
  })
})
