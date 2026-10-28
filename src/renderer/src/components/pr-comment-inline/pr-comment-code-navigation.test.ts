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
    baseRef: 'main',
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
        branchCompare: compare(),
        branchChanges: [entry],
        statusEntries: []
      })
    ).toEqual({ kind: 'branch-diff', entry, compare: compare() })
  })

  it('prefers the review diff even when the file also has uncommitted edits', () => {
    const entry = branchEntry('src/a.ts')
    expect(
      resolvePRCommentCodeSurface({
        relativePath: 'src/a.ts',
        branchCompare: compare(),
        branchChanges: [entry],
        statusEntries: [statusEntry('src/a.ts')]
      }).kind
    ).toBe('branch-diff')
  })

  it('falls back to Changes mode for a file only the working tree changed', () => {
    expect(
      resolvePRCommentCodeSurface({
        relativePath: 'src/b.ts',
        branchCompare: compare(),
        branchChanges: [branchEntry('src/a.ts')],
        statusEntries: [statusEntry('src/b.ts')]
      })
    ).toEqual({ kind: 'changes' })
  })

  it('lands in a plain tab when no surface holds a hunk for the file', () => {
    expect(
      resolvePRCommentCodeSurface({
        relativePath: 'src/c.ts',
        branchCompare: compare(),
        branchChanges: [branchEntry('src/a.ts')],
        statusEntries: [statusEntry('src/b.ts')]
      })
    ).toEqual({ kind: 'edit' })
  })

  it('does not trust a compare that has not finished, or one without compare OIDs', () => {
    for (const branchCompare of [
      compare({ status: 'loading' }),
      compare({ mergeBase: null }),
      null,
      undefined
    ]) {
      expect(
        resolvePRCommentCodeSurface({
          relativePath: 'src/a.ts',
          branchCompare,
          branchChanges: [branchEntry('src/a.ts')],
          statusEntries: []
        })
      ).toEqual({ kind: 'edit' })
    }
  })
})
