import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ home: '' }))

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: () => mocks.home
}))

import { HOME_DIRECTORY_NAME, LEGACY_HOME_DIRECTORY_NAME } from '../../shared/app-directory-names'
import {
  hasLivePeer,
  hasRegisteredGrokHookOwner,
  registerGrokHookOwner,
  releaseGrokHookOwnerAndCheckForPeers
} from './grok-hook-owners'

const OWNER_DIRECTORY = ['agent-hooks', 'grok-owners']

function ownerPathIn(homeDirectoryName: string, token: string): string {
  return join(mocks.home, homeDirectoryName, ...OWNER_DIRECTORY, `owner-${token}.json`)
}

function peer(token: string, pid = process.pid): { token: string; pid: number } {
  return { token, pid }
}

describe('Grok hook owners', () => {
  const directories: string[] = []

  async function makeDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'orca-grok-owners-'))
    directories.push(directory)
    return directory
  }

  beforeEach(async () => {
    mocks.home = await makeDirectory()
  })

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
  })

  it('keeps the shared hook while another Orca process is live', async () => {
    const directory = await makeDirectory()
    const live = peer('11111111-1111-4111-8111-111111111111', 42)
    await writeFile(join(directory, `owner-${live.token}.json`), JSON.stringify(live))

    await expect(hasLivePeer(directory, 'self', vi.fn().mockResolvedValue(true))).resolves.toBe(
      true
    )
  })

  it('prunes dead and malformed owners before allowing cleanup', async () => {
    const directory = await makeDirectory()
    const dead = peer('22222222-2222-4222-8222-222222222222', 43)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `owner-${dead.token}.json`), JSON.stringify(dead))
    await writeFile(join(directory, 'owner-33333333-3333-4333-8333-333333333333.json'), 'not json')

    await expect(hasLivePeer(directory, 'self', vi.fn().mockResolvedValue(false))).resolves.toBe(
      false
    )
    await expect(
      readFile(join(directory, `owner-${dead.token}.json`), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves the hook when peer liveness is unverifiable', async () => {
    const directory = await makeDirectory()
    const live = peer('44444444-4444-4444-8444-444444444444', 44)
    await writeFile(join(directory, `owner-${live.token}.json`), JSON.stringify(live))

    await expect(
      hasLivePeer(directory, 'self', vi.fn().mockResolvedValue(undefined))
    ).resolves.toBe(true)
  })

  it('detects a new owner record without another liveness probe', async () => {
    const directory = await makeDirectory()
    const live = peer('55555555-5555-4555-8555-555555555555', 45)
    await writeFile(join(directory, `owner-${live.token}.json`), JSON.stringify(live))

    await expect(hasRegisteredGrokHookOwner([directory])).resolves.toBe(true)
  })

  // Why: both installs write the one shared Grok hook config, so quitting this build must not
  // remove it while an official Orca holds the same file.
  it('sees an official install’s running process as a peer', async () => {
    const official = peer('66666666-6666-4666-8666-666666666666')
    await mkdir(join(mocks.home, LEGACY_HOME_DIRECTORY_NAME, ...OWNER_DIRECTORY), {
      recursive: true
    })
    await writeFile(
      ownerPathIn(LEGACY_HOME_DIRECTORY_NAME, official.token),
      JSON.stringify(official)
    )
    registerGrokHookOwner()

    await expect(releaseGrokHookOwnerAndCheckForPeers()).resolves.toBe(true)
    await expect(hasRegisteredGrokHookOwner()).resolves.toBe(true)
  })

  it('leaves the official install’s owner records untouched', async () => {
    const officialDirectory = join(mocks.home, LEGACY_HOME_DIRECTORY_NAME, ...OWNER_DIRECTORY)
    await mkdir(officialDirectory, { recursive: true })
    const unreadable = join(officialDirectory, 'owner-77777777-7777-4777-8777-777777777777.json')
    await writeFile(unreadable, 'not json')
    registerGrokHookOwner()

    await expect(releaseGrokHookOwnerAndCheckForPeers()).resolves.toBe(false)
    // Pruning belongs to the install that owns the directory.
    await expect(readFile(unreadable, 'utf8')).resolves.toBe('not json')
  })

  it('ignores this build’s own directory when it holds no records', async () => {
    await mkdir(join(mocks.home, HOME_DIRECTORY_NAME, ...OWNER_DIRECTORY), { recursive: true })
    registerGrokHookOwner()

    await expect(releaseGrokHookOwnerAndCheckForPeers()).resolves.toBe(false)
    await expect(hasRegisteredGrokHookOwner()).resolves.toBe(false)
  })
})
