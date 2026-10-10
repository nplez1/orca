import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
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

/** Where this install records the stores it has already decided about. */
const ADOPTION_MARKER_DIRECTORY = '.adopted'

function adoptionMarkerPathIn(home: string, segments: readonly string[]): string {
  // Why the separators are folded into the file name: one marker per store path, so deciding about
  // `jira-sites.json` never has to know what was decided about `jira-tokens`.
  return join(home, HOME_DIRECTORY_NAME, ADOPTION_MARKER_DIRECTORY, segments.join('__'))
}

/**
 * The path a store should read and write, having adopted its pre-rename copy once.
 *
 * Why the decision is recorded rather than inferred from the paths: "the fork's copy is missing" is
 * also true for a store the user has just deleted, so inferring it lets a deleted credential reappear
 * from the pre-rename copy on the next read — and replication then pushes the resurrected credential
 * to every paired host.
 *
 * Why the marker is written even when there was nothing to adopt: once this install has resolved a
 * store, the pre-rename path belongs to an official install. Adopting a file that appears there
 * afterwards would take that install's data.
 *
 * Returns the legacy path only when the copy could not be made — a read-only or full disk must not
 * look like a connection the user never configured. No marker is written in that case, so the next
 * run tries again. It is a degraded path and not a stable state: it writes to the shared directory,
 * which is exactly what the rename exists to stop.
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
  const marker = adoptionMarkerPathIn(home, [segment, ...segments])
  if (existsSync(marker)) {
    return current
  }
  // Why this comes before the legacy path: the fork's own copy may be *newer* than the pre-rename one
  // — a user who has been on the renamed build keeps writing here — so adopting over it would lose
  // more than it recovers.
  if (existsSync(current)) {
    markAdoptionDecided(marker)
    return current
  }
  const legacy = resolveLegacyHomeStorePathIn(home, segment, ...segments)
  if (!existsSync(legacy)) {
    markAdoptionDecided(marker)
    return current
  }
  try {
    adoptLegacyCopy(legacy, current)
    markAdoptionDecided(marker)
    return current
  } catch (error) {
    if (existsSync(current)) {
      // Why: two processes can adopt the same store at once; the loser reads the winner's copy.
      markAdoptionDecided(marker)
      return current
    }
    console.warn(
      `[orca] Could not move ${[segment, ...segments].join('/')} into ${HOME_DIRECTORY_NAME}; using the copy in ${LEGACY_HOME_DIRECTORY_NAME}`,
      error
    )
    return legacy
  }
}

function markAdoptionDecided(marker: string): void {
  try {
    mkdirSync(dirname(marker), { recursive: true })
    writeFileSync(marker, '', { flag: 'wx' })
  } catch (error) {
    // Why not fatal: an unwritable marker costs one redundant adoption check next run, while throwing
    // here would take the store's own caller down over a bookkeeping file. EEXIST is the normal case —
    // another process decided the same store first.
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
    if (code !== 'EEXIST') {
      console.warn('[orca] Could not record that a pre-rename store has been considered', error)
    }
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
