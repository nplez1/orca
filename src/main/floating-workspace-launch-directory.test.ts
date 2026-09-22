import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ensureFloatingWorkspaceLaunchDirectory,
  ensureFloatingWorkspaceLaunchDirectorySync,
  resolveFloatingWorkspaceLaunchDirectory
} from './floating-workspace-launch-directory'

describe('floating workspace launch directory', () => {
  let homeDir: string
  let launchDirectory: string

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), 'orca-floating-launch-dir-'))
    launchDirectory = path.join(homeDir, '.orca', 'floating-workspace')
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('resolves under the given home directory', () => {
    expect(resolveFloatingWorkspaceLaunchDirectory(homeDir)).toBe(launchDirectory)
  })

  it('creates the folder and seeds comment-only agent instructions', async () => {
    await expect(ensureFloatingWorkspaceLaunchDirectory(homeDir)).resolves.toBe(launchDirectory)

    const starter = readFileSync(path.join(launchDirectory, 'AGENTS.md'), 'utf-8').trim()
    expect(starter.startsWith('<!--')).toBe(true)
    expect(starter.endsWith('-->')).toBe(true)
  })

  it('keeps agent instructions the user already wrote', async () => {
    mkdirSync(launchDirectory, { recursive: true })
    const userInstructions = '# My floating workspace rules\n'
    writeFileSync(path.join(launchDirectory, 'AGENTS.md'), userInstructions)

    await ensureFloatingWorkspaceLaunchDirectory(homeDir)

    expect(readFileSync(path.join(launchDirectory, 'AGENTS.md'), 'utf-8')).toBe(userInstructions)
  })

  it('does not seed a second instruction file when CLAUDE.md exists', async () => {
    mkdirSync(launchDirectory, { recursive: true })
    writeFileSync(path.join(launchDirectory, 'CLAUDE.md'), '# Claude rules\n')

    await ensureFloatingWorkspaceLaunchDirectory(homeDir)

    expect(existsSync(path.join(launchDirectory, 'AGENTS.md'))).toBe(false)
  })

  it('creates and seeds the folder from the synchronous variant', () => {
    expect(ensureFloatingWorkspaceLaunchDirectorySync(homeDir)).toBe(launchDirectory)
    expect(existsSync(path.join(launchDirectory, 'AGENTS.md'))).toBe(true)
  })
})
