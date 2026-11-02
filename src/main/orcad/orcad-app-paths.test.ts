import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveOrcadInstallRoot, resolveUserDataPath } from './orcad-app-paths'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
  vi.unstubAllEnvs()
})

describe('resolveUserDataPath', () => {
  it('prefers ORCA_USER_DATA, then XDG_DATA_HOME, then ~/.orca-np', () => {
    vi.stubEnv('ORCA_USER_DATA', join(sep, 'srv', 'orca-state'))
    vi.stubEnv('XDG_DATA_HOME', join(sep, 'xdg'))
    expect(resolveUserDataPath()).toBe(join(sep, 'srv', 'orca-state'))

    vi.stubEnv('ORCA_USER_DATA', '')
    expect(resolveUserDataPath()).toBe(join(sep, 'xdg', 'orca-np'))

    vi.stubEnv('XDG_DATA_HOME', '')
    expect(resolveUserDataPath()).toBe(join(homedir(), '.orca-np'))
  })
})

describe('resolveOrcadInstallRoot', () => {
  // Bundle siblings live beside symlink targets, not the link.
  it.skipIf(process.platform === 'win32')('follows a symlinked script to the real bundle', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orcad-install-root-')))
    try {
      const bundle = join(root, 'slot')
      const bin = join(root, 'bin')
      mkdirSync(bundle)
      mkdirSync(bin)
      writeFileSync(join(bundle, 'orcad.js'), '')
      symlinkSync(join(bundle, 'orcad.js'), join(bin, 'orcad'))
      expect(resolveOrcadInstallRoot(join(bin, 'orcad'))).toBe(bundle)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses instead of guessing when the process has no main script', () => {
    const originalArgv = process.argv
    // node -e omits argv[1]; cwd cannot establish the install root.
    process.argv = [process.execPath]
    try {
      expect(() => resolveOrcadInstallRoot()).toThrow(/orcad_install_root_unavailable/)
    } finally {
      process.argv = originalArgv
    }
  })
})
