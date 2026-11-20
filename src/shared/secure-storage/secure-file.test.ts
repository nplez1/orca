import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetSecureFileHardenedPathsForTests,
  hardenExistingSecureFile,
  writeSecureFile
} from './secure-file'

const posixModeIt = process.platform === 'win32' ? it.skip : it

describe('POSIX secure files', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const tempDirs: string[] = []

  beforeEach(() => {
    __resetSecureFileHardenedPathsForTests()
  })

  afterEach(() => {
    __resetSecureFileHardenedPathsForTests()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(dir)
    return dir
  }

  posixModeIt('restricts the published file and its directory by mode', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const userDataPath = tempDir()
    const targetPath = join(userDataPath, 'secret.json')

    expect(writeSecureFile(targetPath, 'contents')).toBe(true)

    expect(statMode(targetPath)).toBe(0o600)
    expect(statMode(userDataPath)).toBe(0o700)
  })

  posixModeIt('leaves the directory alone when the caller says so, and needs it to exist', () => {
    // Why: a caller writing into a directory it does not own — a repo checkout, a shared /tmp —
    // cannot afford the parent being hardened to 0700 under it.
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const parent = tempDir()
    chmodSync(parent, 0o755)
    const targetPath = join(parent, 'secret.json')

    expect(writeSecureFile(targetPath, 'contents', { hardenDirectory: false })).toBe(true)

    expect(statMode(targetPath)).toBe(0o600)
    expect(statMode(parent)).toBe(0o755)
    // The parent is the caller's, so it is not created either.
    expect(() =>
      writeSecureFile(join(parent, 'absent', 'secret.json'), 'contents', { hardenDirectory: false })
    ).toThrow()
    expect(statMode(parent)).toBe(0o755)
  })

  posixModeIt('re-hardens a POSIX directory when its metadata changes after caching', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const userDataPath = tempDir()
    const targetPath = join(userDataPath, 'secret.json')
    writeFileSync(targetPath, '{}')

    hardenExistingSecureFile(targetPath)
    expect(statMode(userDataPath)).toBe(0o700)

    chmodSync(userDataPath, 0o755)
    hardenExistingSecureFile(targetPath)

    expect(statMode(userDataPath)).toBe(0o700)
  })
})

function statMode(path: string): number {
  return statSync(path).mode & 0o777
}
