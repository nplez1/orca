import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createSessionSummaryScratchDir,
  SESSION_SUMMARY_SCRATCH_MAX_AGE_MS,
  sweepStaleSessionSummaryScratchDirs
} from './session-summary-scratch'

const roots: string[] = []
function scratchRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-307-sweep-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function age(path: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs)
  utimesSync(path, when, when)
}

describe('session-summary scratch directories', () => {
  it('creates a new directory per call rather than reusing one', () => {
    const root = scratchRoot()

    const first = createSessionSummaryScratchDir(root)
    const second = createSessionSummaryScratchDir(root)

    expect(first).not.toBe(second)
    expect(statSync(first).isDirectory()).toBe(true)
    expect(statSync(second).isDirectory()).toBe(true)
    expect(readdirSync(first)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('creates it private to this user', () => {
    const dir = createSessionSummaryScratchDir(scratchRoot())

    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(dir).uid).toBe(process.getuid?.())
  })

  it('removes only old directories of its own making', async () => {
    const root = scratchRoot()
    const stale = join(root, 'orca-session-summary-abc123')
    const fresh = join(root, 'orca-session-summary-def456')
    const legacy = join(root, 'orca-session-summary')
    const linked = join(root, 'orca-session-summary-ghi789')
    const target = join(scratchRoot(), 'not-ours')
    for (const path of [stale, fresh, legacy, target]) {
      mkdirSync(path)
    }
    // Windows needs elevation to create a symlink; the guard is the platform's, not the sweep's.
    if (process.platform !== 'win32') {
      symlinkSync(target, linked)
    }
    age(stale, SESSION_SUMMARY_SCRATCH_MAX_AGE_MS * 2)

    const removed = await sweepStaleSessionSummaryScratchDirs({ root })

    expect(removed).toBe(1)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(legacy)).toBe(true)
    // A planted symlink is never followed, so its target survives.
    expect(existsSync(target)).toBe(true)
    if (process.platform !== 'win32') {
      expect(existsSync(linked)).toBe(true)
    }
  })

  it('reaps a directory the real helper created', async () => {
    const root = scratchRoot()
    const dir = createSessionSummaryScratchDir(root)
    age(dir, SESSION_SUMMARY_SCRATCH_MAX_AGE_MS * 2)

    await expect(sweepStaleSessionSummaryScratchDirs({ root })).resolves.toBe(1)

    expect(existsSync(dir)).toBe(false)
  })

  it('removes only directories, never a file wearing the same name', async () => {
    const root = scratchRoot()
    const foreign = join(root, 'orca-session-summary-abc123')
    mkdirSync(foreign)
    writeFileSync(join(foreign, 'CLAUDE.md'), 'planted')
    age(foreign, SESSION_SUMMARY_SCRATCH_MAX_AGE_MS * 2)
    const file = join(root, 'orca-session-summary-xyz789')
    writeFileSync(file, 'not a directory')
    age(file, SESSION_SUMMARY_SCRATCH_MAX_AGE_MS * 2)

    const removed = await sweepStaleSessionSummaryScratchDirs({
      root,
      now: Date.now(),
      maxAgeMs: SESSION_SUMMARY_SCRATCH_MAX_AGE_MS
    })

    // Both are old and correctly shaped; only the directory is ours to delete.
    expect(removed).toBe(1)
    expect(existsSync(foreign)).toBe(false)
    expect(existsSync(file)).toBe(true)
  })

  it('ignores a root that does not exist', async () => {
    await expect(
      sweepStaleSessionSummaryScratchDirs({ root: join(scratchRoot(), 'missing') })
    ).resolves.toBe(0)
  })
})
