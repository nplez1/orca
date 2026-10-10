import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveValidatedClonePath, getClonePathComparisonKey } from './repo-clone-path'

describe('repo clone path helpers', () => {
  it('allows safe repository names that start with two dots', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'orca-clone-path-'))
    try {
      expect(
        deriveValidatedClonePath({
          url: 'https://example.com/..repo.git',
          destination
        })
      ).toBe(join(destination, '..repo'))
    } finally {
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('rejects Windows-looking destinations on non-Windows hosts', async () => {
    if (process.platform === 'win32') {
      return
    }
    expect(() =>
      deriveValidatedClonePath({
        url: 'https://example.com/orca.git',
        destination: 'C:\\Users\\me\\src'
      })
    ).toThrow('Clone destination must be an absolute path')
    expect(() =>
      deriveValidatedClonePath({
        url: 'https://example.com/orca.git',
        destination: '\\\\server\\share'
      })
    ).toThrow('Clone destination must be an absolute path')
    expect(() =>
      deriveValidatedClonePath({
        url: 'https://example.com/orca.git',
        destination: '//server/share'
      })
    ).toThrow('Clone destination must be an absolute path')
    expect(() =>
      deriveValidatedClonePath({
        url: 'https://example.com/orca.git',
        destination: '//wsl.localhost/Ubuntu/home/me'
      })
    ).toThrow('Clone destination must be an absolute path')
  })

  it('canonicalizes WSL UNC server aliases without folding Linux path casing', () => {
    expect(getClonePathComparisonKey('\\\\wsl.localhost\\Ubuntu\\home\\User\\repo')).toBe(
      getClonePathComparisonKey('\\\\wsl$\\ubuntu\\home\\User\\repo')
    )
    expect(getClonePathComparisonKey('\\\\wsl.localhost\\Ubuntu\\home\\User\\repo\\')).toBe(
      getClonePathComparisonKey('\\\\wsl$\\ubuntu\\home\\User\\repo')
    )
    expect(getClonePathComparisonKey('\\\\wsl.localhost\\Ubuntu\\home\\User\\repo')).not.toBe(
      getClonePathComparisonKey('\\\\wsl$\\ubuntu\\home\\user\\repo')
    )
  })

  it('nests the checkout under the project folder when one is given', () => {
    expect(
      deriveValidatedClonePath({
        url: 'https://example.com/orca.git',
        destination: '/orca/workspaces',
        relativeClonePath: 'orca/main'
      })
    ).toBe(join('/orca/workspaces', 'orca', 'main'))
  })

  it('refuses a project-folder path that escapes the destination', () => {
    // Why: the relative path is composed from names the caller sanitized, so escaping it is a
    // caller bug — and this is the check that turns it into an error instead of a stray clone.
    expect(() =>
      deriveValidatedClonePath({
        url: 'https://example.com/orca.git',
        destination: '/orca/workspaces',
        relativeClonePath: '../../elsewhere/main'
      })
    ).toThrow('Clone path must be inside the destination directory')
  })

  it('keeps a leading-slash segment inside the destination rather than resetting to it', () => {
    // Why asserted rather than rejected: `join` reads the leading slash as a separator, so the
    // path stays under the destination. Containment, not the caller's spelling, is the boundary.
    expect(
      deriveValidatedClonePath({
        url: 'https://example.com/orca.git',
        destination: '/orca/workspaces',
        relativeClonePath: '/orca/main'
      })
    ).toBe(join('/orca/workspaces', 'orca', 'main'))
  })
})
