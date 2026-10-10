import { copyFileSync, cpSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { HOME_DIRECTORY_NAME, LEGACY_HOME_DIRECTORY_NAME } from '../shared/app-directory-names'

/**
 * Where a store this build owns lives under the fork's home directory, and how it hands over the
 * copy an earlier build left in upstream's.
 *
 * Why this exists as one module: `local(identity)` renamed the home directory to `.orca-np`, but a
 * handful of upstream-added stores still write to `~/.orca` — the same directory an official Orca
 * install owns. Repointing each of them is a per-store data migration, not a constant swap, so the
 * migration belongs here rather than repeated in five path getters.
 *
 * Two rules this module exists to keep:
 *
 * 1. **Only a named store is ever adopted, never the home directory itself.** Copying `~/.orca`
 *    wholesale would take an official install's state with it.
 * 2. **The pre-rename copy is left where it is.** It may belong to an official install, and a user
 *    who goes back to one must still find their data.
 */

/** The fork's own copy of a store, which is where every caller wants to end up. */
export function resolveHomeStorePathIn(
  home: string,
  segment: string,
  ...segments: string[]
): string {
  return join(home, HOME_DIRECTORY_NAME, segment, ...segments)
}

function resolveLegacyHomeStorePathIn(
  home: string,
  segment: string,
  ...segments: string[]
): string {
  return join(home, LEGACY_HOME_DIRECTORY_NAME, segment, ...segments)
}

/**
 * The path a store should read and write, having adopted its pre-rename copy on first use.
 *
 * Returns the legacy path only when the copy could not be made — a read-only or full disk must not
 * look like a connection the user never configured. That fallback writes to the shared directory,
 * which is exactly what the rename exists to stop, so it is a degraded path and not a stable state.
 *
 * A segment is required so the home directory itself can never be adopted: that would take an
 * official install's whole state along with this build's stores.
 *
 * `home` is injectable because the floating workspace resolves its own (see `homeDir` there).
 */
export function adoptLegacyHomeStoreIn(
  home: string,
  segment: string,
  ...segments: string[]
): string {
  const current = resolveHomeStorePathIn(home, segment, ...segments)
  if (existsSync(current)) {
    return current
  }
  const legacy = resolveLegacyHomeStorePathIn(home, segment, ...segments)
  if (!existsSync(legacy)) {
    return current
  }
  try {
    adoptLegacyCopy(legacy, current)
    return current
  } catch (error) {
    if (existsSync(current)) {
      // Why: two processes can adopt the same store at once; the loser reads the winner's copy.
      return current
    }
    console.warn(
      `[orca] Could not move ${[segment, ...segments].join('/')} into ${HOME_DIRECTORY_NAME}; using the copy in ${LEGACY_HOME_DIRECTORY_NAME}`,
      error
    )
    return legacy
  }
}

/** {@link adoptLegacyHomeStoreIn} for the real home directory. */
export function adoptLegacyHomeStore(segment: string, ...segments: string[]): string {
  return adoptLegacyHomeStoreIn(homedir(), segment, ...segments)
}

function adoptLegacyCopy(legacy: string, current: string): void {
  mkdirSync(dirname(current), { recursive: true })
  if (!statSync(legacy).isDirectory()) {
    // Why copyFileSync: it carries the source's permissions, so a 0600 credential stays 0600.
    copyFileSync(legacy, current)
    return
  }
  // Why staged: a half-copied directory would otherwise be adopted as complete on the next run.
  const staging = `${current}.migrating-${process.pid}`
  rmSync(staging, { recursive: true, force: true })
  try {
    cpSync(legacy, staging, { recursive: true })
    renameSync(staging, current)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
