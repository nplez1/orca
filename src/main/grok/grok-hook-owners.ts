import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { readdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HOME_DIRECTORY_NAME, LEGACY_HOME_DIRECTORY_NAME } from '../../shared/app-directory-names'

const ownerToken = randomUUID()
const OWNER_FILE_PATTERN = /^owner-([\da-f-]{36})\.json$/i
const GROK_OWNER_DIRECTORY_NAME = 'grok-owners'

type GrokHookOwner = { token: string; pid: number }

function ownerDirectoryIn(homeDirectoryName: string): string {
  return join(homedir(), homeDirectoryName, 'agent-hooks', GROK_OWNER_DIRECTORY_NAME)
}

function ownerDirectory(): string {
  return ownerDirectoryIn(HOME_DIRECTORY_NAME)
}

/**
 * Every install's owner directory: this build's, then the one an official Orca owns.
 *
 * Why both: the Grok hook config is a single shared file, so a peer registered under either name
 * keeps it in use — and quit cleanup used to strip an official install's entries because it only
 * looked in this build's directory.
 */
function ownerDirectories(): string[] {
  return [ownerDirectoryIn(HOME_DIRECTORY_NAME), ownerDirectoryIn(LEGACY_HOME_DIRECTORY_NAME)]
}

function ownerPath(directory = ownerDirectory()): string {
  return join(directory, `owner-${ownerToken}.json`)
}

export function registerGrokHookOwner(): void {
  const directory = ownerDirectory()
  mkdirSync(directory, { recursive: true })
  try {
    writeFileSync(
      ownerPath(directory),
      `${JSON.stringify({ token: ownerToken, pid: process.pid } satisfies GrokHookOwner)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 }
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
  }
}

export function unregisterGrokHookOwnerSync(): void {
  rmSync(ownerPath(), { force: true })
}

export async function releaseGrokHookOwnerAndCheckForPeers(): Promise<boolean> {
  const ownDirectory = ownerDirectory()
  await rm(ownerPath(ownDirectory), { force: true })
  // Why pruning only in this build's directory: a dead record under the official install's name is
  // not this build's to delete, and it cannot prove a live peer either way.
  const peers = await Promise.all(
    ownerDirectories().map((directory, index) =>
      hasLivePeer(directory, ownerToken, probeProcess, { prune: index === 0 })
    )
  )
  return peers.some(Boolean)
}

/** Fast second check after liveness pruning closes the registration race before cleanup commits. */
export async function hasRegisteredGrokHookOwner(
  directories: readonly string[] = ownerDirectories()
): Promise<boolean> {
  for (const directory of directories) {
    if (await hasRegisteredOwnerIn(directory)) {
      return true
    }
  }
  return false
}

async function hasRegisteredOwnerIn(directory: string): Promise<boolean> {
  try {
    return (await readdir(directory)).some((entry) => OWNER_FILE_PATTERN.test(entry))
  } catch (error) {
    // Why: unverifiable ownership must preserve the shared hook, never delete it.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

export async function hasLivePeer(
  directory: string,
  currentToken: string,
  probe: (pid: number) => Promise<boolean | undefined>,
  options: { prune?: boolean } = {}
): Promise<boolean> {
  const prune = options.prune !== false
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    // Why: unverifiable ownership must preserve the shared hook, never delete it.
    return true
  }

  for (const entry of entries) {
    const token = OWNER_FILE_PATTERN.exec(entry)?.[1]
    if (!token || token === currentToken) {
      continue
    }
    const path = join(directory, entry)
    let owner: GrokHookOwner | null = null
    try {
      const candidate = JSON.parse(await readFile(path, 'utf8')) as Partial<GrokHookOwner>
      if (
        candidate.token === token &&
        Number.isSafeInteger(candidate.pid) &&
        (candidate.pid ?? 0) > 0
      ) {
        owner = candidate as GrokHookOwner
      }
    } catch {
      // Invalid Orca-owned records cannot prove a live peer and are pruned below.
    }
    if (!owner) {
      if (prune) {
        await rm(path, { force: true })
      }
      continue
    }
    const live = await probe(owner.pid)
    if (live === false) {
      if (prune) {
        await rm(path, { force: true })
      }
      continue
    }
    // true proves liveness; undefined means the platform could not prove death.
    return true
  }
  return false
}

async function probeProcess(pid: number): Promise<boolean | undefined> {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : undefined
  }
}
