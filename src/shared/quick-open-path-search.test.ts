import { describe, expect, it } from 'vitest'
import {
  NameFilterPathMatcher,
  pathMatchesQueryTokens,
  splitPathQueryTokens
} from './quick-open-path-search'

describe('splitPathQueryTokens', () => {
  it('splits on whitespace and lowercases', () => {
    expect(splitPathQueryTokens('  Drover\tEVE\nschema ')).toEqual(['drover', 'eve', 'schema'])
  })

  it('returns no tokens for an empty query', () => {
    expect(splitPathQueryTokens('   ')).toEqual([])
  })
})

describe('pathMatchesQueryTokens', () => {
  it('requires every token to appear anywhere in the path', () => {
    const tokens = splitPathQueryTokens('drover eve')
    expect(pathMatchesQueryTokens('src/a/b/Drover.eve_schema', tokens)).toBe(true)
    expect(pathMatchesQueryTokens('src/a/b/drover-other.ts', tokens)).toBe(false)
  })

  it('matches everything when there are no tokens', () => {
    expect(pathMatchesQueryTokens('src/a.ts', [])).toBe(true)
  })
})

describe('NameFilterPathMatcher', () => {
  function matcher(query: string, limit: number): NameFilterPathMatcher {
    return new NameFilterPathMatcher(query, limit)
  }

  it('counts every match while retaining the lexicographically first page', () => {
    const subject = matcher('target', 2)
    for (const path of [
      'src/target-d.ts',
      'src/target-c.ts',
      'src/other.ts',
      'src/target-a.ts',
      'src/target-b.ts'
    ]) {
      subject.consider(path)
    }

    // The page is a stable sorted prefix, not whatever the scan reached first.
    expect(subject.result()).toEqual({
      paths: ['src/target-a.ts', 'src/target-b.ts'],
      totalCount: 4
    })
  })

  it('reports an exact total past the retention bound', () => {
    const subject = matcher('file', 1)
    for (let index = 0; index < 5_000; index += 1) {
      subject.consider(`src/file-${index}.ts`)
    }

    expect(subject.result()).toEqual({ paths: ['src/file-0.ts'], totalCount: 5_000 })
  })

  it('ignores paths that do not match and queries that cannot match', () => {
    const subject = matcher('drover', 10)
    subject.consider('src/unrelated.ts')

    expect(subject.result()).toEqual({ paths: [], totalCount: 0 })
    expect(matcher('   ', 10).result()).toEqual({ paths: [], totalCount: 0 })
    expect(matcher('x', 0).result()).toEqual({ paths: [], totalCount: 0 })
  })
})
