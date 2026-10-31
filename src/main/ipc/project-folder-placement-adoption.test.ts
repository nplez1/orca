import { describe, expect, it } from 'vitest'
import { chooseExistingDirectoryName } from './project-folder-placement'

describe('chooseExistingDirectoryName', () => {
  it('prefers an exact match, so a case-sensitive volume keeps both folders apart', () => {
    expect(chooseExistingDirectoryName(['orca', 'Orca'], 'Orca')).toBe('Orca')
    expect(chooseExistingDirectoryName(['orca', 'Orca'], 'orca')).toBe('orca')
  })

  it('refuses to guess when two entries fold to the name', () => {
    // Why: two such entries mean the filesystem is case-sensitive, where they are two folders and
    // picking either one would move every existing worktree's container out from under it.
    expect(chooseExistingDirectoryName(['orca', 'ORCA'], 'Orca')).toBe('Orca')
  })

  it('reuses the single on-disk spelling when the volume folds case', () => {
    expect(chooseExistingDirectoryName(['orca'], 'Orca')).toBe('orca')
  })

  it('keeps the requested spelling when nothing matches', () => {
    expect(chooseExistingDirectoryName([], 'Orca')).toBe('Orca')
    expect(chooseExistingDirectoryName(['other'], 'Orca')).toBe('Orca')
    expect(chooseExistingDirectoryName(['orca'], '')).toBe('')
  })
})
