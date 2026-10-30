import { describe, expect, it } from 'vitest'
import {
  canonicalWorktreePath,
  areWorktreePathsEqual,
  dedupeWorktreesByPath
} from './worktree-path-comparison'
import * as upstreamComparison from '../main/git/worktree-path-comparison'

// Every path flavour the two consumers of this module compare: project-folder placement compares
// container names and roots, relocation compares a repo path with its container.
const PATH_CORPUS = [
  '/home/dev/repo',
  '/home/dev/Repo',
  '/private/tmp/orca/feature',
  '/tmp/orca/feature',
  'C:\\Workspaces\\Feature',
  'c:/workspaces/feature',
  '\\\\Server\\Share\\Feature',
  '//server/share/feature',
  '\\\\wsl.localhost\\Ubuntu\\home\\dev\\Feature',
  '\\\\wsl$\\ubuntu\\home\\dev\\feature',
  '//wsl$/UBUNTU/home/dev/feature',
  '//wsl.localhost/Ubuntu/mnt/c/Users/Dev/Repo',
  '//wsl.localhost/Ubuntu/MNT/c/Users/Dev/Repo',
  'orca',
  'Orca',
  'workspaces/feature',
  'workspaces/./feature',
  'repo'
]

const PLATFORMS = ['darwin', 'linux', 'win32'] as const

describe('canonicalWorktreePath', () => {
  it('keeps a WSL Linux tail case-sensitive while folding the distro name', () => {
    const upper = '//wsl.localhost/Ubuntu/home/dev/Feature'
    const lower = '//wsl.localhost/Ubuntu/home/dev/feature'
    expect(canonicalWorktreePath(upper, 'win32')).not.toBe(canonicalWorktreePath(lower, 'win32'))
    expect(canonicalWorktreePath('//wsl.localhost/UBUNTU/home/dev/Feature', 'win32')).toBe(
      canonicalWorktreePath(upper, 'win32')
    )
  })

  it('folds the drvfs tail of a /mnt path, which Windows backends resolve case-insensitively', () => {
    expect(
      areWorktreePathsEqual(
        '//wsl.localhost/Ubuntu/mnt/c/Users/Dev/Repo',
        '//wsl.localhost/Ubuntu/mnt/c/users/dev/repo',
        'win32'
      )
    ).toBe(true)
  })

  it('treats the /tmp and /private/tmp spellings of one macOS checkout as equal', () => {
    expect(areWorktreePathsEqual('/private/tmp/orca/feature', '/tmp/orca/feature', 'darwin')).toBe(
      true
    )
    expect(areWorktreePathsEqual('/private/tmp/orca/feature', '/tmp/orca/feature', 'linux')).toBe(
      false
    )
  })

  it('never equates a POSIX path with a Windows path', () => {
    expect(areWorktreePathsEqual('/home/dev/repo', 'C:\\home\\dev\\repo', 'win32')).toBe(false)
  })

  it('compares the bare container names project-folder placement passes in', () => {
    expect(areWorktreePathsEqual('orca', 'orca', 'darwin')).toBe(true)
    expect(areWorktreePathsEqual('orca', 'Orca', 'darwin')).toBe(false)
  })
})

describe('dedupeWorktreesByPath', () => {
  it('keeps WSL checkouts that differ only in the Linux tail case', () => {
    const rows = [
      { id: 'upper', path: '//wsl.localhost/Ubuntu/home/dev/Feature' },
      { id: 'lower', path: '//wsl.localhost/Ubuntu/home/dev/feature' }
    ]
    expect(dedupeWorktreesByPath(rows, 'win32').map((row) => row.id)).toEqual(['upper', 'lower'])
  })

  it('collapses one checkout reported through each WSL UNC spelling and separator style', () => {
    const rows = [
      { id: 'first', path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\feature' },
      { id: 'alias', path: '//wsl$/ubuntu/home/dev/feature' },
      { id: 'distro-case', path: '\\\\WSL.LOCALHOST\\UBUNTU\\home\\dev\\feature' }
    ]
    expect(dedupeWorktreesByPath(rows, 'win32').map((row) => row.id)).toEqual(['first'])
  })

  it('preserves the first row of a duplicate POSIX or Windows pair', () => {
    const rows = [
      { id: 'posix-first', path: '/home/dev/Repo/' },
      { id: 'posix-second', path: '/home/dev/Repo' },
      { id: 'windows-first', path: 'C:\\Workspaces\\Feature' },
      { id: 'windows-second', path: 'c:/workspaces/feature' }
    ]
    for (const platform of PLATFORMS) {
      expect(dedupeWorktreesByPath(rows, platform).map((row) => row.id)).toEqual([
        'posix-first',
        'windows-first'
      ])
    }
  })
})

// The web project cannot import upstream's module (it pulls the desktop command runner), so this port
// is a copy. Parity is asserted rather than assumed: an upstream sync that changes the comparison
// rules fails here instead of silently leaving the renderer-facing consumers on old behaviour.
describe('parity with upstream git/worktree-path-comparison', () => {
  it('canonicalizes every corpus path the way upstream does', () => {
    for (const platform of PLATFORMS) {
      for (const pathValue of PATH_CORPUS) {
        expect(canonicalWorktreePath(pathValue, platform)).toBe(
          upstreamComparison.canonicalWorktreePath(pathValue, platform)
        )
      }
    }
  })

  it('agrees with upstream on every corpus pair', () => {
    for (const platform of PLATFORMS) {
      for (const left of PATH_CORPUS) {
        for (const right of PATH_CORPUS) {
          expect(areWorktreePathsEqual(left, right, platform)).toBe(
            upstreamComparison.areWorktreePathsEqual(left, right, platform)
          )
        }
      }
    }
  })

  it('dedupes the corpus the way upstream does', () => {
    const rows = PATH_CORPUS.map((path, index) => ({ id: `row-${index}`, path }))
    for (const platform of PLATFORMS) {
      expect(dedupeWorktreesByPath(rows, platform).map((row) => row.id)).toEqual(
        upstreamComparison.dedupeWorktreesByPath(rows, platform).map((row) => row.id)
      )
    }
  })
})
