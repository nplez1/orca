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
  prepareSessionSummaryFoldCwd,
  SESSION_SUMMARY_FOLD_CWD_DIR_NAME,
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

describe('the fold working directory', () => {
  it('creates it empty and keeps it at one path', () => {
    const root = scratchRoot()

    const first = prepareSessionSummaryFoldCwd(root)
    writeFileSync(join(first, 'leftover'), 'from a previous call')
    const second = prepareSessionSummaryFoldCwd(root)

    expect(first).toBe(second)
    expect(second).toBe(join(root, SESSION_SUMMARY_FOLD_CWD_DIR_NAME))
    expect(readdirSync(second)).toEqual([])
  })

  it('empties a directory a previous run left content in', () => {
    const root = scratchRoot()
    const dir = join(root, SESSION_SUMMARY_FOLD_CWD_DIR_NAME)
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, 'CLAUDE.md'), 'planted')
    writeFileSync(join(dir, '.claude', 'settings.json'), '{}')

    prepareSessionSummaryFoldCwd(root)

    expect(readdirSync(dir)).toEqual([])
  })

  it('replaces a file at that path with a directory', () => {
    const root = scratchRoot()
    writeFileSync(join(root, SESSION_SUMMARY_FOLD_CWD_DIR_NAME), 'not a directory')

    const dir = prepareSessionSummaryFoldCwd(root)

    expect(statSync(dir).isDirectory()).toBe(true)
    expect(readdirSync(dir)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('replaces a symlink instead of following it', () => {
    const root = scratchRoot()
    const target = join(scratchRoot(), 'planted')
    mkdirSync(target)
    writeFileSync(join(target, 'CLAUDE.md'), 'planted')
    symlinkSync(target, join(root, SESSION_SUMMARY_FOLD_CWD_DIR_NAME))

    const dir = prepareSessionSummaryFoldCwd(root)

    expect(statSync(dir).isDirectory()).toBe(true)
    expect(readdirSync(dir)).toEqual([])
    expect(readdirSync(target)).toEqual(['CLAUDE.md'])
  })

  it.skipIf(process.platform === 'win32')('tightens a directory left with a wider mode', () => {
    const root = scratchRoot()
    const dir = join(root, SESSION_SUMMARY_FOLD_CWD_DIR_NAME)
    mkdirSync(dir, { recursive: true, mode: 0o755 })

    expect(prepareSessionSummaryFoldCwd(root)).toBe(dir)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })
})

describe('the transcript scratch sweep', () => {
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

  it('removes only directories, never a file wearing the same name', async () => {
    const root = scratchRoot()
    const stale = join(root, 'orca-session-summary-abc123')
    mkdirSync(stale)
    age(stale, SESSION_SUMMARY_SCRATCH_MAX_AGE_MS * 2)
    const file = join(root, 'orca-session-summary-xyz789')
    writeFileSync(file, 'not a directory')
    age(file, SESSION_SUMMARY_SCRATCH_MAX_AGE_MS * 2)

    await expect(sweepStaleSessionSummaryScratchDirs({ root })).resolves.toBe(1)

    expect(existsSync(stale)).toBe(false)
    expect(existsSync(file)).toBe(true)
  })

  it('ignores a root that does not exist', async () => {
    await expect(
      sweepStaleSessionSummaryScratchDirs({ root: join(scratchRoot(), 'missing') })
    ).resolves.toBe(0)
  })
})
