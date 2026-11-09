import { posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  computeWorktreePath,
  ensurePathWithinWorkspace,
  getWorktreeCreationLayout,
  getWorktreePathSettings,
  sanitizeWorktreeName
} from './worktree-logic'
import { computeBranchName, computeValidatedBranchName } from './worktree-branch-name'
import { sanitizeWorktreeDisplayName } from './worktree-display-name'
import { areWorktreePathsEqual } from '../git/worktrees/catalog/worktree-path-comparison'

describe('sanitizeWorktreeName', () => {
  it('keeps a .lock suffix, which only a ref rejects, not a directory', () => {
    // Branch construction rewrites this (see computeBranchName); the folder keeps the name.
    expect(sanitizeWorktreeName('foo.lock')).toBe('foo.lock')
    expect(sanitizeWorktreeName('add.FOO.LOCK')).toBe('add.FOO.LOCK')
  })

  it('preserves non-ASCII letters and numbers', () => {
    expect(sanitizeWorktreeName('中文')).toBe('中文')
    expect(sanitizeWorktreeName('日本語 テスト')).toBe('日本語-テスト')
    expect(sanitizeWorktreeName('café-déjà')).toBe('café-déjà')
    expect(sanitizeWorktreeName('Привет мир')).toBe('Привет-мир')
  })
})

describe('sanitizeWorktreeDisplayName', () => {
  it('strips bidi override controls from external artifact titles', () => {
    expect(sanitizeWorktreeDisplayName('Review \u202eexe.txt')).toBe('Review exe.txt')
  })
})

describe('ensurePathWithinWorkspace', () => {
  it('throws when path traverses outside workspace', () => {
    expect(() => ensurePathWithinWorkspace('/workspace/../outside', '/workspace')).toThrow(
      'Invalid worktree path'
    )
  })
})

describe('computeBranchName', () => {
  it('rewrites a .lock leaf, which git rejects in a ref', () => {
    expect(computeBranchName('foo.lock', { branchPrefix: 'none' }, null)).toBe('foo-lock')
    expect(computeBranchName('foo.lock', { branchPrefix: 'git-username' }, 'jdoe')).toBe(
      'jdoe/foo-lock'
    )
    // Any case: `foo.LOCK` collides with `foo`'s loose-ref lock file on a case-insensitive filesystem.
    expect(computeBranchName('foo.LOCK', { branchPrefix: 'none' }, null)).toBe('foo-lock')
    // A suffixed leaf does not end in .lock, so it needs no rewrite.
    expect(computeBranchName('foo.lock-2', { branchPrefix: 'none' }, null)).toBe('foo.lock-2')
  })
})

describe('computeValidatedBranchName', () => {
  it('rewrites a .lock leaf on the create path', () => {
    expect(computeValidatedBranchName('foo.lock', { branchPrefix: 'none' }, null)).toBe('foo-lock')
    expect(computeValidatedBranchName('foo.LOCK', { branchPrefix: 'none' }, null)).toBe('foo-lock')
    expect(
      computeValidatedBranchName(
        'foo.lock',
        { branchPrefix: 'custom', branchPrefixCustom: 'team' },
        null
      )
    ).toBe('team/foo-lock')
    expect(computeValidatedBranchName('foo.lock', { branchPrefix: 'git-username' }, 'jdoe')).toBe(
      'jdoe/foo-lock'
    )
  })

  it('rewrites a trailing .lock so git check-ref-format accepts the branch', () => {
    const none = { branchPrefix: 'none' } as const
    expect(computeValidatedBranchName(sanitizeWorktreeName('adopt mise.lock'), none, null)).toBe(
      'adopt-mise-lock'
    )
    expect(computeValidatedBranchName(sanitizeWorktreeName('mise.lock!'), none, null)).toBe(
      'mise-lock'
    )
    expect(computeValidatedBranchName('mise-.lock', none, null)).toBe('mise-lock')
    expect(computeValidatedBranchName('mise.lock.json', none, null)).toBe('mise.lock.json')
    expect(
      computeValidatedBranchName(
        'mise.lock',
        { branchPrefix: 'custom', branchPrefixCustom: 'team' },
        null
      )
    ).toBe('team/mise-lock')
  })
})

describe('computeWorktreePath', () => {
  it('scopes the same relative repo override to each repo root', () => {
    const settings = { nestWorkspaces: false, workspaceDir: '/global/workspaces' }
    const repoA = { path: '/projects/a/repo', worktreeBasePath: '../worktrees' }
    const repoB = { path: '/projects/b/repo', worktreeBasePath: '../worktrees' }

    expect(
      computeWorktreePath('feature', repoA.path, getWorktreePathSettings(repoA, settings))
    ).toBe(posix.resolve('/projects/a/worktrees/feature'))
    expect(
      computeWorktreePath('feature', repoB.path, getWorktreePathSettings(repoB, settings))
    ).toBe(posix.resolve('/projects/b/worktrees/feature'))
    expect(getWorktreeCreationLayout(repoA, settings)).toEqual({
      path: '../worktrees',
      nestWorkspaces: false,
      worktreeLayoutMode: 'flat'
    })
  })
})

describe('areWorktreePathsEqual', () => {
  it('keeps WSL-owned POSIX paths case-sensitive on Windows', () => {
    expect(areWorktreePathsEqual('/home/dev/Repo', '/home/dev/repo', 'win32')).toBe(false)
  })
})
