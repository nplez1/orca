import { describe, expect, it } from 'vitest'
import type {
  GitBranchChangeEntry,
  GitBranchCompareSummary
} from '../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import { resolvePRCommentCodeSurface } from './pr-comment-code-navigation'

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

function branchEntry(path: string): GitBranchChangeEntry {
  return { path, status: 'modified', added: 3, removed: 1 }
}

function statusEntry(path: string): GitStatusEntry {
  return { path, status: 'modified', area: 'unstaged' }
}

describe('resolvePRCommentCodeSurface', () => {
  it('lands in the branch diff, which carries the review hunks', () => {
    const entry = branchEntry('src/a.ts')
    expect(
      resolvePRCommentCodeSurface({
        relativePath: 'src/a.ts',
        reviewBaseRefName: 'main',
        branchCompare: compare(),
        branchChanges: [entry],
        statusEntries: []
      })
    ).toEqual({ kind: 'branch-diff', entry, compare: compare() })
  })

  it('prefers the review diff even when the file also has uncommitted edits', () => {
    expect(
      resolvePRCommentCodeSurface({
        relativePath: 'src/a.ts',
        reviewBaseRefName: 'main',
        branchCompare: compare(),
        branchChanges: [branchEntry('src/a.ts')],
        statusEntries: [statusEntry('src/a.ts')]
      }).kind
    ).toBe('branch-diff')
  })

  it('falls back to Changes mode for a file only the working tree changed', () => {
    expect(
      resolvePRCommentCodeSurface({
        relativePath: 'src/b.ts',
        reviewBaseRefName: 'main',
        branchCompare: compare(),
        branchChanges: [branchEntry('src/a.ts')],
        statusEntries: [statusEntry('src/b.ts')]
      })
    ).toEqual({ kind: 'changes' })
  })

  it('lands in a plain tab only once the review diff proves the file is outside it', () => {
    expect(
      resolvePRCommentCodeSurface({
        relativePath: 'src/c.ts',
        reviewBaseRefName: 'main',
        branchCompare: compare(),
        branchChanges: [branchEntry('src/a.ts')],
        statusEntries: [statusEntry('src/b.ts')]
      })
    ).toEqual({ kind: 'edit' })
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
          branchChanges: [branchEntry('src/a.ts')],
          statusEntries: []
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
        branchChanges: [branchEntry('src/a.ts')],
        statusEntries: []
      })
    ).toEqual({ kind: 'changes' })
    // Why Changes mode still wins for a dirty file: its hunks are real, unlike a foreign base's.
    expect(
      resolvePRCommentCodeSurface({
        relativePath: 'src/a.ts',
        reviewBaseRefName: 'main',
        branchCompare,
        branchChanges: [branchEntry('src/a.ts')],
        statusEntries: [statusEntry('src/a.ts')]
      }).kind
    ).toBe('changes')
    // A base the provider did not name leaves the compare's own base as the only claim available.
    expect(
      resolvePRCommentCodeSurface({
        relativePath: 'src/a.ts',
        reviewBaseRefName: null,
        branchCompare,
        branchChanges: [branchEntry('src/a.ts')],
        statusEntries: []
      }).kind
    ).toBe('branch-diff')
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
          branchChanges: [branchEntry('src/a.ts')],
          statusEntries: []
        }).kind
      ).toBe('branch-diff')
    }
  })
})
