import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_DATA_DIRECTORY_NAME } from '../../shared/app-directory-names'
import { getDefaultUserDataPath, getPlatformUserDataPath } from './metadata'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('getPlatformUserDataPath', () => {
  // Why: the app pins this directory on every platform (configure-process.ts), so a literal `orca`
  // here reads an official install's runtime metadata and auth token instead of this build's.
  it('resolves this build’s own profile on Linux', () => {
    vi.stubEnv('XDG_CONFIG_HOME', '')
    expect(getPlatformUserDataPath('linux', '/home/me')).toBe(
      join('/home/me', '.config', APP_DATA_DIRECTORY_NAME)
    )
    expect(getPlatformUserDataPath('linux', '/home/me')).not.toContain('/orca/')
  })

  it('honours XDG_CONFIG_HOME on Linux', () => {
    vi.stubEnv('XDG_CONFIG_HOME', '/xdg/config')
    expect(getPlatformUserDataPath('linux', '/home/me')).toBe(
      join('/xdg/config', APP_DATA_DIRECTORY_NAME)
    )
  })

  it('resolves the macOS profile from the home directory', () => {
    expect(getPlatformUserDataPath('darwin', '/Users/me')).toBe(
      join('/Users/me', 'Library', 'Application Support', APP_DATA_DIRECTORY_NAME)
    )
  })

  it('resolves the Windows profile from APPDATA', () => {
    vi.stubEnv('APPDATA', 'C:\\Users\\me\\AppData\\Roaming')
    expect(getPlatformUserDataPath('win32', 'C:\\Users\\me')).toBe(
      join('C:\\Users\\me\\AppData\\Roaming', APP_DATA_DIRECTORY_NAME)
    )
  })
})

describe('getDefaultUserDataPath', () => {
  it('prefers an explicit ORCA_USER_DATA_PATH over the platform profile', () => {
    vi.stubEnv('ORCA_USER_DATA_PATH', '/tmp/isolated-profile')
    expect(getDefaultUserDataPath('darwin', '/Users/me')).toBe('/tmp/isolated-profile')
  })

  it('falls back to the platform profile', () => {
    vi.stubEnv('ORCA_USER_DATA_PATH', '')
    vi.stubEnv('XDG_CONFIG_HOME', '')
    expect(getDefaultUserDataPath('linux', '/home/me')).toBe(
      join('/home/me', '.config', APP_DATA_DIRECTORY_NAME)
    )
  })
})
