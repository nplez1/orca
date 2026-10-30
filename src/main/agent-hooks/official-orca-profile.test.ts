import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hasOfficialOrcaProfile, officialOrcaProfilePath } from './official-orca-profile'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-official-profile-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('officialOrcaProfilePath', () => {
  it('resolves Electron’s appData child per platform', () => {
    expect(officialOrcaProfilePath('darwin', home, {})).toBe(
      join(home, 'Library', 'Application Support', 'orca')
    )
    expect(officialOrcaProfilePath('linux', home, {})).toBe(join(home, '.config', 'orca'))
    expect(officialOrcaProfilePath('linux', home, { XDG_CONFIG_HOME: '/xdg' })).toBe(
      join('/xdg', 'orca')
    )
    expect(officialOrcaProfilePath('win32', home, { APPDATA: 'C:\\appdata' })).toBe(
      join('C:\\appdata', 'orca')
    )
  })

  it('has no answer on Windows without APPDATA', () => {
    expect(officialOrcaProfilePath('win32', home, {})).toBeNull()
    expect(hasOfficialOrcaProfile('win32', home, {})).toBe(false)
  })
})

describe('hasOfficialOrcaProfile', () => {
  it('answers false until the official install has laid down its profile', () => {
    expect(hasOfficialOrcaProfile('darwin', home, {})).toBe(false)
    const profilePath = join(home, 'Library', 'Application Support', 'orca')
    mkdirSync(profilePath, { recursive: true })
    expect(hasOfficialOrcaProfile('darwin', home, {})).toBe(true)
  })

  it('does not mistake this build’s own profile for an official one', () => {
    mkdirSync(join(home, '.config', 'orca-np'), { recursive: true })
    expect(hasOfficialOrcaProfile('linux', home, {})).toBe(false)
  })

  // Why: builds before the coordination root moved wrote `bundle-coordination` into upstream's
  // profile, and a machine that only ever ran that build must still sweep its own `.orca` leftovers.
  it('ignores a profile holding only this build’s pre-rename park tree', () => {
    const profilePath = join(home, 'Library', 'Application Support', 'orca')
    mkdirSync(join(profilePath, 'bundle-coordination', 'abc'), { recursive: true })
    expect(hasOfficialOrcaProfile('darwin', home, {})).toBe(false)

    // Anything else in there is the official app's.
    mkdirSync(join(profilePath, 'Local Storage'), { recursive: true })
    expect(hasOfficialOrcaProfile('darwin', home, {})).toBe(true)
  })
})
