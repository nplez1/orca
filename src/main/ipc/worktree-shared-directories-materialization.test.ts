import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorktreeSharedPaths } from './worktree-symlinks'

const posixIt = process.platform === 'win32' ? it.skip : it

describe('createWorktreeSharedPaths', () => {
  let root: string
  let primary: string
  let worktree: string
  let warn: ReturnType<typeof vi.spyOn>
  let error: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-sharedpaths-'))
    primary = join(root, 'primary')
    worktree = join(root, 'worktree')
    mkdirSync(primary, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    error = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    error.mockRestore()
    rmSync(root, { recursive: true, force: true })
  })

  // Why: this setting is opt-in; existing projects retain the shared-write symlink behavior.
  posixIt('keeps the legacy symlink behavior when no APFS mode is selected', async () => {
    mkdirSync(join(primary, 'node_modules'))
    writeFileSync(join(primary, 'node_modules', 'marker'), 'ORIG\n')
    const cloneWorktreePath = vi.fn()

    await createWorktreeSharedPaths(primary, worktree, ['node_modules'], {
      platform: 'darwin',
      cloneWorktreePath
    })

    expect(cloneWorktreePath).not.toHaveBeenCalled()
    expect(lstatSync(join(worktree, 'node_modules')).isSymbolicLink()).toBe(true)
  })

  it('uses an APFS clone when the APFS-symlink mode is selected', async () => {
    writeFileSync(join(primary, '.env'), 'SECRET=1\n')
    const cloneWorktreePath = vi.fn(async (_source: string, target: string) => {
      writeFileSync(target, 'CLONED=1\n')
    })

    await createWorktreeSharedPaths(primary, worktree, ['.env'], {
      platform: 'darwin',
      sharedDirectoriesMode: 'apfs-symlink',
      cloneWorktreePath
    })

    expect(cloneWorktreePath).toHaveBeenCalledOnce()
    expect(lstatSync(join(worktree, '.env')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(worktree, '.env'), 'utf8')).toBe('CLONED=1\n')
  })

  it('publishes a completed staged directory clone', async () => {
    mkdirSync(join(primary, 'node_modules'))
    const cloneWorktreePath = vi.fn(async (_source: string, target: string) => {
      mkdirSync(target)
      writeFileSync(join(target, 'marker'), 'CLONED\n')
    })

    await createWorktreeSharedPaths(primary, worktree, ['node_modules'], {
      platform: 'darwin',
      sharedDirectoriesMode: 'apfs-only',
      cloneWorktreePath
    })

    expect(readFileSync(join(worktree, 'node_modules', 'marker'), 'utf8')).toBe('CLONED\n')
    expect(readdirSync(worktree)).toEqual(['node_modules'])
  })

  posixIt(
    'APFS-only clones a symlinked directory referent without publishing a symlink',
    async () => {
      mkdirSync(join(primary, '.cache-real'))
      symlinkSync(join(primary, '.cache-real'), join(primary, '.cache'), 'dir')
      const cloneWorktreePath = vi.fn(async (source: string, target: string) => {
        mkdirSync(target)
        writeFileSync(join(target, 'marker'), source)
      })

      await createWorktreeSharedPaths(primary, worktree, ['.cache'], {
        platform: 'darwin',
        sharedDirectoriesMode: 'apfs-only',
        cloneWorktreePath
      })

      expect(cloneWorktreePath).toHaveBeenCalledWith(
        realpathSync(join(primary, '.cache-real')),
        expect.stringContaining(join(worktree, '.orca-worktree-stage-')),
        true
      )
      expect(lstatSync(join(worktree, '.cache')).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(worktree, '.cache', 'marker'), 'utf8')).toBe(
        realpathSync(join(primary, '.cache-real'))
      )
    }
  )

  posixIt('falls back to a symlink when APFS cloning is unavailable', async () => {
    writeFileSync(join(primary, '.env'), 'SECRET=1\n')
    const cloneWorktreePath = vi.fn(async () => {
      throw new Error('clonefile unsupported')
    })

    await createWorktreeSharedPaths(primary, worktree, ['.env'], {
      platform: 'darwin',
      sharedDirectoriesMode: 'apfs-symlink',
      cloneWorktreePath
    })

    expect(lstatSync(join(worktree, '.env')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(worktree, '.env'))).toBe(join(primary, '.env'))
  })

  it('falls back to an independent copy instead of a symlink when selected', async () => {
    writeFileSync(join(primary, '.env'), 'SECRET=1\n')
    const cloneWorktreePath = vi.fn(async () => {
      throw new Error('clonefile unsupported')
    })

    await createWorktreeSharedPaths(primary, worktree, ['.env'], {
      platform: 'darwin',
      sharedDirectoriesMode: 'apfs-copy',
      cloneWorktreePath
    })

    expect(lstatSync(join(worktree, '.env')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(worktree, '.env'), 'utf8')).toBe('SECRET=1\n')
    writeFileSync(join(worktree, '.env'), 'LOCAL=1\n')
    expect(readFileSync(join(primary, '.env'), 'utf8')).toBe('SECRET=1\n')
  })

  it('removes a partial directory clone when APFS-only mode cannot clone', async () => {
    mkdirSync(join(primary, 'node_modules'))
    writeFileSync(join(primary, 'node_modules', 'complete'), 'PRIMARY\n')
    const cloneWorktreePath = vi.fn(async (_source: string, target: string) => {
      mkdirSync(target)
      writeFileSync(join(target, 'partial'), 'PARTIAL\n')
      throw new Error('clonefile unsupported')
    })

    const failedPaths = await createWorktreeSharedPaths(primary, worktree, ['node_modules'], {
      platform: 'darwin',
      sharedDirectoriesMode: 'apfs-only',
      cloneWorktreePath
    })

    expect(failedPaths).toEqual(['node_modules'])
    expect(existsSync(join(worktree, 'node_modules'))).toBe(false)
    expect(readdirSync(worktree)).toEqual([])
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('APFS-only materialization did not complete')
    )
  })

  it('warns when APFS-only mode is selected on a non-macOS host', async () => {
    mkdirSync(join(primary, 'node_modules'))

    const failedPaths = await createWorktreeSharedPaths(primary, worktree, ['node_modules'], {
      platform: 'linux',
      sharedDirectoriesMode: 'apfs-only'
    })

    expect(failedPaths).toEqual(['node_modules'])
    expect(existsSync(join(worktree, 'node_modules'))).toBe(false)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('APFS-only materialization did not complete')
    )
  })

  it('honors the explicit copy fallback even below the generic copy budget', async () => {
    mkdirSync(join(primary, 'node_modules'))
    writeFileSync(join(primary, 'node_modules', 'complete'), 'PRIMARY\n')
    const cloneWorktreePath = vi.fn(async (_source: string, target: string) => {
      mkdirSync(target)
      writeFileSync(join(target, 'partial'), 'PARTIAL\n')
      throw new Error('clonefile unsupported')
    })

    await createWorktreeSharedPaths(primary, worktree, ['node_modules'], {
      platform: 'darwin',
      sharedDirectoriesMode: 'apfs-copy',
      copyBudget: { maxBytes: 0, maxEntries: 100 },
      cloneWorktreePath
    })

    expect(readFileSync(join(worktree, 'node_modules', 'complete'), 'utf8')).toBe('PRIMARY\n')
    expect(existsSync(join(worktree, 'node_modules', 'partial'))).toBe(false)
    expect(readdirSync(worktree)).toEqual(['node_modules'])
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('APFS clone failed and a real copy')
    )
  })

  it('copies the complete source directory after a partial APFS clone fails', async () => {
    mkdirSync(join(primary, 'node_modules'))
    writeFileSync(join(primary, 'node_modules', 'complete'), 'PRIMARY\n')
    const cloneWorktreePath = vi.fn(async (_source: string, target: string) => {
      mkdirSync(target)
      writeFileSync(join(target, 'partial'), 'PARTIAL\n')
      throw new Error('clonefile unsupported')
    })

    await createWorktreeSharedPaths(primary, worktree, ['node_modules'], {
      platform: 'darwin',
      sharedDirectoriesMode: 'apfs-copy',
      cloneWorktreePath
    })

    expect(readFileSync(join(worktree, 'node_modules', 'complete'), 'utf8')).toBe('PRIMARY\n')
    expect(existsSync(join(worktree, 'node_modules', 'partial'))).toBe(false)
    expect(readdirSync(worktree)).toEqual(['node_modules'])
  })

  it('does not merge a copy fallback into a target created while APFS cloning fails', async () => {
    mkdirSync(join(primary, 'node_modules'))
    writeFileSync(join(primary, 'node_modules', 'complete'), 'PRIMARY\n')
    const target = join(worktree, 'node_modules')
    const cloneWorktreePath = vi.fn(async (_source: string, stagingTarget: string) => {
      mkdirSync(stagingTarget)
      writeFileSync(join(stagingTarget, 'partial'), 'PARTIAL\n')
      mkdirSync(target)
      writeFileSync(join(target, 'user'), 'USER\n')
      throw new Error('clonefile unsupported')
    })

    const failedPaths = await createWorktreeSharedPaths(primary, worktree, ['node_modules'], {
      platform: 'darwin',
      sharedDirectoriesMode: 'apfs-copy',
      cloneWorktreePath
    })

    expect(failedPaths).toEqual([])
    expect(readdirSync(target)).toEqual(['user'])
    expect(readFileSync(join(target, 'user'), 'utf8')).toBe('USER\n')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Materialization target appeared before publish')
    )
    expect(error).not.toHaveBeenCalled()
  })

  it('preserves an empty target directory that appears before staged publish', async () => {
    mkdirSync(join(primary, 'node_modules'))
    const target = join(worktree, 'node_modules')
    let racedTargetIdentity: { dev: number; ino: number } | undefined
    const cloneWorktreePath = vi.fn(async (_source: string, stagingTarget: string) => {
      mkdirSync(stagingTarget)
      writeFileSync(join(stagingTarget, 'clone'), 'CLONE\n')
      mkdirSync(target)
      const racedTargetStats = lstatSync(target)
      racedTargetIdentity = { dev: racedTargetStats.dev, ino: racedTargetStats.ino }
    })

    await createWorktreeSharedPaths(primary, worktree, ['node_modules'], {
      platform: 'darwin',
      sharedDirectoriesMode: 'apfs-only',
      cloneWorktreePath
    })

    const publishedTargetStats = lstatSync(target)
    expect(racedTargetIdentity).toEqual({
      dev: publishedTargetStats.dev,
      ino: publishedTargetStats.ino
    })
    expect(readdirSync(target)).toEqual([])
    expect(readdirSync(worktree)).toEqual(['node_modules'])
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Materialization target appeared before publish')
    )
  })

  posixIt('shares one directory so worktree writes reach the primary checkout', async () => {
    mkdirSync(join(primary, 'node_modules'))

    await createWorktreeSharedPaths(primary, worktree, ['node_modules'], { platform: 'linux' })

    writeFileSync(join(worktree, 'node_modules', 'installed'), 'SHARED\n')
    expect(readFileSync(join(primary, 'node_modules', 'installed'), 'utf8')).toBe('SHARED\n')
  })

  posixIt('skips a path already materialized by the per-user symlink pass', async () => {
    mkdirSync(join(primary, 'node_modules'))
    mkdirSync(join(worktree, 'node_modules'))

    await createWorktreeSharedPaths(primary, worktree, ['node_modules'], { platform: 'linux' })

    expect(lstatSync(join(worktree, 'node_modules')).isSymbolicLink()).toBe(false)
  })

  it('rejects unsafe paths without touching the filesystem', async () => {
    writeFileSync(join(root, 'outside.txt'), 'DO_NOT_TOUCH')

    await createWorktreeSharedPaths(primary, worktree, ['../outside.txt', '/etc/passwd'], {
      platform: 'linux'
    })

    expect(readFileSync(join(root, 'outside.txt'), 'utf8')).toBe('DO_NOT_TOUCH')
    expect(warn).toHaveBeenCalled()
  })
})
