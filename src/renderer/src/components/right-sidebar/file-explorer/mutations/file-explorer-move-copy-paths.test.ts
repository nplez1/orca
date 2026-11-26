import { describe, expect, it } from 'vitest'
import {
  classifyMoveDestination,
  copyNameCandidates,
  outermostPaths
} from './file-explorer-move-copy-paths'

describe('classifyMoveDestination', () => {
  it('refuses a folder moved into itself or its subtree, on either separator', () => {
    expect(classifyMoveDestination('/w/src', '/w/src')).toBe('inside-source')
    expect(classifyMoveDestination('/w/src', '/w/src/lib/deep')).toBe('inside-source')
    expect(classifyMoveDestination('C:\\w\\src', 'C:\\w\\src\\lib')).toBe('inside-source')
  })

  it('treats the current parent as a no-op and a sibling prefix as a real destination', () => {
    expect(classifyMoveDestination('/w/src/a.ts', '/w/src')).toBe('same-folder')
    expect(classifyMoveDestination('/w/src', '/w/src-old')).toBe('allowed')
    expect(classifyMoveDestination('/w/src/a.ts', '/w')).toBe('allowed')
  })
})

describe('outermostPaths', () => {
  it('drops selected paths that a selected folder already carries', () => {
    expect(outermostPaths(['/w/src', '/w/src/a.ts', '/w/src-old/b.ts', '/w/c.ts'])).toEqual([
      '/w/src',
      '/w/src-old/b.ts',
      '/w/c.ts'
    ])
  })
})

describe('copyNameCandidates', () => {
  const firstThree = (name: string, keepName: boolean): string[] => {
    const names = copyNameCandidates(name, keepName)
    return [names.next().value, names.next().value, names.next().value]
  }

  it("keeps the name in another folder, then follows Duplicate's sequence", () => {
    expect(firstThree('a.test.ts', true)).toEqual([
      'a.test.ts',
      'a.test copy.ts',
      'a.test copy 2.ts'
    ])
    expect(firstThree('a.ts', false)).toEqual(['a copy.ts', 'a copy 2.ts', 'a copy 3.ts'])
  })

  it('treats a dotfile and an extensionless name as all stem', () => {
    expect(firstThree('.env', false)).toEqual(['.env copy', '.env copy 2', '.env copy 3'])
    expect(firstThree('Makefile', false)).toEqual([
      'Makefile copy',
      'Makefile copy 2',
      'Makefile copy 3'
    ])
  })
})
