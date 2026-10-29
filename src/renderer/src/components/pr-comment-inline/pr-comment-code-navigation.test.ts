import { describe, expect, it } from 'vitest'
import type {
  GitBranchChangeEntry,
  GitBranchCompareSummary
} from '../../../../shared/git-diff-compare-types'
import type { PRComment } from '../../../../shared/github/comment-types'
import {
  resolvePRCommentCodeSurface,
  resolvePRCommentCodeTarget
} from './pr-comment-code-navigation'

const OID = 'a'.repeat(40)

function compare(overrides: Partial<GitBranchCompareSummary> = {}): GitBranchCompareSummary {
  return {
    baseRef: 'origin/main',
    baseOid: OID,
    compareRef: 'HEAD',
    headOid: OID,
    mergeBase: OID,
    changedFiles: 1,
    status: 'ready',
    ...overrides
  }
}

function branchEntry(path: string, oldPath?: string): GitBranchChangeEntry {
  return { path, oldPath, status: 'modified', added: 3, removed: 1 }
}

function comment(overrides: Partial<PRComment>): PRComment {
  return {
    id: 1,
    author: 'reviewer',
    authorAvatarUrl: '',
    body: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    url: 'https://example.test/comment',
    ...overrides
  }
}

describe('resolvePRCommentCodeTarget', () => {
  it('opens the recorded line whenever the provider still maps it', () => {
    expect(resolvePRCommentCodeTarget(comment({ path: 'src/a.ts', line: 42 }), '/repo')).toEqual({
      relativePath: 'src/a.ts',
      line: 42,
      reveal: true
    })
  })

  it('still opens an outdated thread, but withholds the scroll it cannot vouch for', () => {
    expect(
      resolvePRCommentCodeTarget(comment({ path: 'src/a.ts', line: 42, isOutdated: true }), '/repo')
    ).toEqual({ relativePath: 'src/a.ts', line: 42, reveal: false })
  })

  it('refuses a comment no worktree can hold', () => {
    expect(resolvePRCommentCodeTarget(comment({ path: 'src/a.ts', line: 1 }), null)).toBeNull()
    expect(resolvePRCommentCodeTarget(comment({ line: 1 }), '/repo')).toBeNull()
    expect(resolvePRCommentCodeTarget(comment({ path: 'src/a.ts' }), '/repo')).toBeNull()
  })
})

describe('resolvePRCommentCodeSurface', () => {
  it('lands in the branch diff, which carries the review hunks', () => {
    const entry = branchEntry('src/a.ts')
    expect(
      resolvePRCommentCodeSurface({
        relativePath: 'src/a.ts',
        reviewBaseRefName: 'main',
        branchCompare: compare(),
        branchChanges: [entry]
      })
    ).toEqual({ kind: 'branch-diff', entry, compare: compare() })
  })

  it('finds the file a thread still names by its pre-rename path', () => {
    const entry = branchEntry('src/renamed.ts', 'src/a.ts')
    expect(
      resolvePRCommentCodeSurface({
        relativePath: 'src/a.ts',
        reviewBaseRefName: 'main',
        branchCompare: compare(),
        branchChanges: [entry]
      })
    ).toEqual({ kind: 'branch-diff', entry, compare: compare() })
  })

  it('never lands in a plain tab: a file outside the review still gets the change surface', () => {
    expect(
      resolvePRCommentCodeSurface({
        relativePath: 'src/c.ts',
        reviewBaseRefName: 'main',
        branchCompare: compare(),
        branchChanges: [branchEntry('src/a.ts')]
      })
    ).toEqual({ kind: 'changes' })
  })

  it('keeps the explaining surface when no review diff is known for the file', () => {
    for (const branchCompare of [
      compare({ status: 'loading' }),
      compare({ mergeBase: null }),
      null,
      undefined
    ]) {
      expect(
        resolvePRCommentCodeSurface({
          relativePath: 'src/a.ts',
          reviewBaseRefName: 'main',
          branchCompare,
          branchChanges: [branchEntry('src/a.ts')]
        })
      ).toEqual({ kind: 'changes' })
    }
  })

  it('does not treat a compare against another base as the review diff', () => {
    const branchCompare = compare({ baseRef: 'origin/feature-x' })
    expect(
      resolvePRCommentCodeSurface({
        relativePath: 'src/a.ts',
        reviewBaseRefName: 'main',
        branchCompare,
        branchChanges: [branchEntry('src/a.ts')]
      })
    ).toEqual({ kind: 'changes' })
    // A base the provider did not name leaves the compare's own base as the only claim available.
    expect(
      resolvePRCommentCodeSurface({
        relativePath: 'src/a.ts',
        reviewBaseRefName: null,
        branchCompare,
        branchChanges: [branchEntry('src/a.ts')]
      }).kind
    ).toBe('branch-diff')
  })

  it('accepts a base whose local remote ref carries a namespace the provider does not name', () => {
    // The fork's reviews target `main` on the provider, while the worktree pins `origin/nplez1/main`.
    for (const baseRef of [
      'origin/nplez1/main',
      'refs/remotes/origin/nplez1/main',
      'refs/remotes/upstream/main'
    ]) {
      expect(
        resolvePRCommentCodeSurface({
          relativePath: 'src/a.ts',
          reviewBaseRefName: 'main',
          branchCompare: compare({ baseRef }),
          branchChanges: [branchEntry('src/a.ts')]
        }).kind
      ).toBe('branch-diff')
    }
  })

  it('still rejects a compare against an unrelated base branch', () => {
    expect(
      resolvePRCommentCodeSurface({
        relativePath: 'src/a.ts',
        reviewBaseRefName: 'main',
        branchCompare: compare({ baseRef: 'origin/develop' }),
        branchChanges: [branchEntry('src/a.ts')]
      }).kind
    ).toBe('changes')
  })

  it('accepts a base branch whose own name contains a slash', () => {
    for (const baseRef of [
      'release/2.0',
      'origin/release/2.0',
      'refs/remotes/origin/release/2.0'
    ]) {
      expect(
        resolvePRCommentCodeSurface({
          relativePath: 'src/a.ts',
          reviewBaseRefName: 'release/2.0',
          branchCompare: compare({ baseRef }),
          branchChanges: [branchEntry('src/a.ts')]
        }).kind
      ).toBe('branch-diff')
    }
  })
})
