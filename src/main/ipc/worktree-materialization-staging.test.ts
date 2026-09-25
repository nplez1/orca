import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createWorktreeMaterializationStagingDirectory,
  removeStaleWorktreeMaterializationStagingDirectories,
  removeWorktreeMaterializationStagingDirectory
} from './worktree-materialization-staging'

const posixIt = process.platform === 'win32' ? it.skip : it

describe('removeStaleWorktreeMaterializationStagingDirectories', () => {
  let root: string
  let worktree: string
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-staging-cleanup-'))
    worktree = join(root, 'worktree')
    mkdirSync(worktree)
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    rmSync(root, { recursive: true, force: true })
  })

  it('removes a staging directory left by a completed or crashed operation', async () => {
    const parent = join(worktree, 'apps', 'web')
    mkdirSync(parent, { recursive: true })
    const stale = mkdtempSync(join(parent, `.orca-worktree-stage-${process.pid}-`))
    writeFileSync(join(stale, '.orca-worktree-stage-owner'), `${process.pid}\n`)
    mkdirSync(join(stale, 'materialized'))
    writeFileSync(join(stale, 'materialized', 'partial'), 'partial')

    await removeStaleWorktreeMaterializationStagingDirectories(worktree, ['apps/web/.env'])

    expect(existsSync(stale)).toBe(false)
  })

  it('preserves a staging directory still active in this process', async () => {
    const active = await createWorktreeMaterializationStagingDirectory(
      join(worktree, 'node_modules')
    )

    await removeStaleWorktreeMaterializationStagingDirectories(worktree, ['node_modules'])

    expect(existsSync(active)).toBe(true)
    await removeWorktreeMaterializationStagingDirectory(active)
    expect(existsSync(active)).toBe(false)
  })

  posixIt('does not sweep staging directories through a symlinked parent', async () => {
    const external = join(root, 'external')
    const stageParent = join(worktree, 'external')
    mkdirSync(external)
    symlinkSync(external, stageParent, 'dir')
    const stagingDirectory = mkdtempSync(join(external, `.orca-worktree-stage-${process.pid}-`))
    writeFileSync(join(stagingDirectory, '.orca-worktree-stage-owner'), `${process.pid}\n`)

    await removeStaleWorktreeMaterializationStagingDirectories(worktree, ['external/file'])

    expect(existsSync(stagingDirectory)).toBe(true)
  })

  posixIt('clears active ownership after staging through a symlinked worktree root', async () => {
    const realWorktree = join(root, 'real-worktree')
    const aliasedWorktree = join(root, 'worktree-alias')
    mkdirSync(realWorktree)
    symlinkSync(realWorktree, aliasedWorktree, 'dir')
    const stagingDirectory = await createWorktreeMaterializationStagingDirectory(
      join(aliasedWorktree, 'node_modules')
    )
    const canonicalStagingDirectory = join(realWorktree, basename(stagingDirectory))

    await removeWorktreeMaterializationStagingDirectory(stagingDirectory)
    mkdirSync(canonicalStagingDirectory)
    writeFileSync(join(canonicalStagingDirectory, '.orca-worktree-stage-owner'), `${process.pid}\n`)

    await removeStaleWorktreeMaterializationStagingDirectories(aliasedWorktree, ['node_modules'])

    expect(existsSync(canonicalStagingDirectory)).toBe(false)
  })

  it('preserves matching directories without a verifiable ownership marker', async () => {
    const unowned = mkdtempSync(join(worktree, `.orca-worktree-stage-${process.pid}-`))

    await removeStaleWorktreeMaterializationStagingDirectories(worktree, [])

    expect(existsSync(unowned)).toBe(true)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Preserving unverified staging directory')
    )
  })
})
