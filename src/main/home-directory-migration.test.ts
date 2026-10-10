import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LEGACY_HOME_DIRECTORY_NAME, HOME_DIRECTORY_NAME } from '../shared/app-directory-names'
import { adoptLegacyHomeStoreIn, resolveHomeStorePathIn } from './home-directory-migration'

describe('home directory migration', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-home-migration-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const legacyDir = (): string => join(home, LEGACY_HOME_DIRECTORY_NAME)
  const currentDir = (): string => join(home, HOME_DIRECTORY_NAME)

  it("resolves a store under the fork's own home directory", () => {
    expect(resolveHomeStorePathIn(home, 'sites.json')).toBe(join(home, '.orca-np', 'sites.json'))
  })

  it('points a fresh install at the fork home when nothing is stored anywhere', () => {
    expect(adoptLegacyHomeStoreIn(home, 'sites.json')).toBe(join(currentDir(), 'sites.json'))
    expect(existsSync(legacyDir())).toBe(false)
  })

  it('adopts a pre-rename file and leaves the original in place', () => {
    mkdirSync(legacyDir(), { recursive: true })
    writeFileSync(join(legacyDir(), 'sites.json'), '{"sites":["kept"]}')

    expect(adoptLegacyHomeStoreIn(home, 'sites.json')).toBe(join(currentDir(), 'sites.json'))
    expect(readFileSync(join(currentDir(), 'sites.json'), 'utf-8')).toBe('{"sites":["kept"]}')
    // Why asserted: the copy may belong to an official install, which must keep working.
    expect(readFileSync(join(legacyDir(), 'sites.json'), 'utf-8')).toBe('{"sites":["kept"]}')
  })

  it('adopts a pre-rename directory without taking the home directory with it', () => {
    mkdirSync(join(legacyDir(), 'tokens'), { recursive: true })
    writeFileSync(join(legacyDir(), 'tokens', 'a.enc'), 'sealed-a')
    writeFileSync(join(legacyDir(), 'unrelated.json'), 'not-ours')

    expect(adoptLegacyHomeStoreIn(home, 'tokens')).toBe(join(currentDir(), 'tokens'))
    expect(readFileSync(join(currentDir(), 'tokens', 'a.enc'), 'utf-8')).toBe('sealed-a')
    expect(existsSync(join(currentDir(), 'unrelated.json'))).toBe(false)
    expect(existsSync(join(legacyDir(), 'unrelated.json'))).toBe(true)
  })

  it("keeps the fork's own copy when the store already has one", () => {
    mkdirSync(currentDir(), { recursive: true })
    writeFileSync(join(currentDir(), 'sites.json'), '{"sites":["ours"]}')
    mkdirSync(legacyDir(), { recursive: true })
    writeFileSync(join(legacyDir(), 'sites.json'), '{"sites":["stale"]}')

    expect(adoptLegacyHomeStoreIn(home, 'sites.json')).toBe(join(currentDir(), 'sites.json'))
    expect(readFileSync(join(currentDir(), 'sites.json'), 'utf-8')).toBe('{"sites":["ours"]}')
  })

  it('falls back to the pre-rename copy when it cannot be adopted, rather than losing it', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mkdirSync(legacyDir(), { recursive: true })
    writeFileSync(join(legacyDir(), 'sites.json'), '{"sites":["only-copy"]}')
    // Why a file: it makes creating the fork home impossible on every platform, without relying on
    // POSIX permissions that a root or Windows runner ignores.
    writeFileSync(currentDir(), 'not a directory')

    expect(adoptLegacyHomeStoreIn(home, 'sites.json')).toBe(join(legacyDir(), 'sites.json'))
    expect(console.warn).toHaveBeenCalled()
  })

  // Why: adoption keyed on "the fork's copy is missing" would resurrect a credential the user had
  // just deleted, and replication would then push it back to every paired host. The decision has to be
  // recorded, not inferred.
  it('does not bring back a store the user deleted', () => {
    mkdirSync(legacyDir(), { recursive: true })
    writeFileSync(join(legacyDir(), 'sites.json'), '{"sites":["kept"]}')

    const adopted = adoptLegacyHomeStoreIn(home, 'sites.json')
    expect(existsSync(adopted)).toBe(true)

    rmSync(adopted)

    expect(adoptLegacyHomeStoreIn(home, 'sites.json')).toBe(adopted)
    expect(existsSync(adopted)).toBe(false)
  })

  // Why: once this install has resolved a store, the pre-rename path is an official install's; a file
  // appearing there afterwards is that install's data, not ours to take.
  it('never adopts a pre-rename file that appears after the decision was made', () => {
    expect(adoptLegacyHomeStoreIn(home, 'sites.json')).toBe(join(currentDir(), 'sites.json'))

    mkdirSync(legacyDir(), { recursive: true })
    writeFileSync(join(legacyDir(), 'sites.json'), '{"sites":["official"]}')

    expect(adoptLegacyHomeStoreIn(home, 'sites.json')).toBe(join(currentDir(), 'sites.json'))
    expect(existsSync(join(currentDir(), 'sites.json'))).toBe(false)
  })

  it('decides each store separately, so one marker cannot block another', () => {
    mkdirSync(legacyDir(), { recursive: true })
    writeFileSync(join(legacyDir(), 'sites.json'), 'sites')
    writeFileSync(join(legacyDir(), 'tokens.enc'), 'tokens')

    adoptLegacyHomeStoreIn(home, 'sites.json')

    expect(readFileSync(adoptLegacyHomeStoreIn(home, 'tokens.enc'), 'utf-8')).toBe('tokens')
  })
})
