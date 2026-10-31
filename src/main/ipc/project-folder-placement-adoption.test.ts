import { describe, expect, it } from 'vitest'
import { adoptExistingDirectoryName, chooseExistingDirectoryName } from './project-folder-placement'

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

describe('adoptExistingDirectoryName guards', () => {
  it('never reads a base that is not a plain local absolute directory', () => {
    // A repo-relative base resolves against this process's cwd, and a WSL or network base is not on
    // this filesystem: reading either would answer for the wrong folder or boot a stopped distro.
    for (const remoteBase of [
      '\\\\wsl.localhost\\Ubuntu\\home\\me\\code',
      '\\\\server\\share',
      '//wsl.localhost/Ubuntu/home/me/code',
      '//server/share',
      '..',
      'relative/base'
    ]) {
      expect(adoptExistingDirectoryName(remoteBase, 'Orca')).toBe('Orca')
    }
  })
})
