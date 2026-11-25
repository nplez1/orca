import { describe, expect, it } from 'vitest'
import { classifyMoveDestination, outermostPaths } from './file-explorer-move-copy-paths'

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
