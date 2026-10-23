import { lstat, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { processIsAlive } from './workspace-path-catalog-spill-io'

const PID_DIRECTORY_NAME = /^[0-9]+$/

export type WorkspacePathCatalogSpillSweepOptions = {
  isProcessAlive?: (pid: number) => boolean
  processStartedAtMs?: number
}

/**
 * Removes spill directories an earlier process left behind. Liveness alone leaks: a recycled PID
 * passes the check forever, so a directory whose newest entry predates this process is stale too.
 * That is only sound while the profile's instance lock is held, which is what rules a live sibling
 * owner out; the diagnostics-only lock bypass does not.
 */
export async function cleanStaleWorkspacePathCatalogSpillDirectories(
  processDirectory: string,
  options: WorkspacePathCatalogSpillSweepOptions = {}
): Promise<void> {
  const rootDirectory = dirname(processDirectory)
  await mkdir(rootDirectory, { recursive: true, mode: 0o700 })
  const currentName = basename(processDirectory)
  const isProcessAlive = options.isProcessAlive ?? processIsAlive
  const processStartedAtMs = options.processStartedAtMs ?? processStartedAt()
  for (const entry of await readdir(rootDirectory, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !PID_DIRECTORY_NAME.test(entry.name) ||
      entry.name === currentName
    ) {
      continue
    }
    const ownerPid = Number(entry.name)
    if (!Number.isSafeInteger(ownerPid)) {
      continue
    }
    const directory = join(rootDirectory, entry.name)
    try {
      if (
        isProcessAlive(ownerPid) &&
        !(await predatesProcessStart(directory, processStartedAtMs))
      ) {
        continue
      }
      await rm(directory, { recursive: true, force: true })
    } catch {
      // One undeletable directory (EBUSY on Windows, EACCES) must not spare its siblings.
      continue
    }
  }
}

const sweepsByRoot = new Map<string, Promise<void>>()

/**
 * Why (issue #156): a launch that restores every catalog from its checkpoint never starts a build,
 * so a sweep tied to `begin-build` alone leaves dead processes' spill directories on disk for good.
 * The first caller to learn a spill root schedules one deferred sweep for this process; the delay
 * keeps discovery, remotes, and stat work off every caller's critical path.
 */
export function scheduleWorkspacePathCatalogSpillSweep(processDirectory: string): Promise<void> {
  const rootDirectory = dirname(processDirectory)
  const scheduled = sweepsByRoot.get(rootDirectory)
  if (scheduled) {
    return scheduled
  }
  const sweep = new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => cleanStaleWorkspacePathCatalogSpillDirectories(processDirectory))
    .catch(() => {
      // A failed sweep must not memoize itself: the next caller gets to try again.
      sweepsByRoot.delete(rootDirectory)
    })
  sweepsByRoot.set(rootDirectory, sweep)
  return sweep
}

function processStartedAt(): number {
  return Date.now() - process.uptime() * 1_000
}

/** Spill files sit flat inside the process directory, so a shallow scan bounds the whole age check. */
async function predatesProcessStart(
  directory: string,
  processStartedAtMs: number
): Promise<boolean> {
  const newestMs = await newestEntryTimestampMs(directory)
  return newestMs !== null && newestMs < processStartedAtMs
}

async function newestEntryTimestampMs(directory: string): Promise<number | null> {
  try {
    let newestMs = (await stat(directory)).mtimeMs
    for (const name of await readdir(directory)) {
      const entry = await lstat(join(directory, name)).catch(() => null)
      if (entry && entry.mtimeMs > newestMs) {
        newestMs = entry.mtimeMs
      }
    }
    return newestMs
  } catch {
    // Unreadable age is not evidence of staleness.
    return null
  }
}
