import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
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
 * What happened to a store's pre-rename copy.
 *
 * Why an outcome rather than a bare path: "the copy failed" and "there was nothing to copy" both
 * produced the empty store a settings pane shows as *unconfigured*, so a user re-entered credentials —
 * which created the fork's copy, and the old code then read that as the decision having been made. The
 * pre-rename copy was never imported, silently and for good.
 */
export type LegacyHomeStoreAdoption =
  | { kind: 'decided' }
  | { kind: 'adopted'; legacyPath: string }
  | {
      kind: 'failed'
      legacyPath: string
      /** Why, in words a settings pane can show next to a retry. */
      reason: string
    }

export type LegacyHomeStoreResolution = {
  /** Where the store should read and write. Never the pre-rename path; see the notes below. */
  path: string
  adoption: LegacyHomeStoreAdoption
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
 * Why the failure paths answer with the fork's own path: the pre-rename path is an official install's,
 * and a failed migration that answered with it would let this build overwrite that install's own
 * credential file. A store that reads as unconfigured, with a reported reason, is recoverable; a
 * clobbered install is not.
 *
 * A segment is required so the home directory itself can never be adopted: that would take an
 * official install's whole state along with this build's stores.
 *
 * `home` is injectable because the floating workspace resolves its own (see `homeDir` there).
 */
export function resolveLegacyHomeStoreIn(
  home: string,
  segment: string,
  ...segments: string[]
): LegacyHomeStoreResolution {
  const current = resolveHomeStorePathIn(home, segment, ...segments)
  const marker = adoptionMarkerPathIn(home, [segment, ...segments])
  const recorded = readAdoptionRecord(marker)
  if (recorded !== null) {
    // Why a recorded decision can still report: the marker distinguishes "nothing to import" from "a copy
    // exists that this build chose not to import", and only the second stays worth telling the user —
    // while still being a decision, so signing out cannot resurrect the pre-rename copy.
    return { path: current, adoption: stillWorthReporting(recorded, current) }
  }
  const legacy = resolveLegacyHomeStorePathIn(home, segment, ...segments)
  const legacyExists = existsSync(legacy)
  // Why this comes before the legacy path: the fork's own copy may be *newer* than the pre-rename one
  // — a user who has been on the renamed build keeps writing here — so adopting over it would lose
  // more than it recovers.
  if (existsSync(current)) {
    if (!legacyExists) {
      markAdoptionDecided(marker)
      return { path: current, adoption: { kind: 'decided' } }
    }
    // Why neither adopted nor the plain decision: this build's copy wins and is left alone, but the
    // pre-rename copy is still un-imported. The decision is recorded so deleting this build's copy
    // cannot re-adopt an official install's, and the record keeps the report alive.
    const adoption = {
      kind: 'failed' as const,
      legacyPath: legacy,
      reason: `${current} already exists, so the copy in ${LEGACY_HOME_DIRECTORY_NAME} was not imported`
    }
    recordUnimportedCopy(marker, adoption)
    return { path: current, adoption }
  }
  if (!legacyExists) {
    markAdoptionDecided(marker)
    return { path: current, adoption: { kind: 'decided' } }
  }
  try {
    adoptLegacyCopy(legacy, current)
    markAdoptionDecided(marker)
    return { path: current, adoption: { kind: 'adopted', legacyPath: legacy } }
  } catch (error) {
    if (existsSync(current)) {
      // Why: two processes can adopt the same store at once; the loser reads the winner's copy.
      markAdoptionDecided(marker)
      return { path: current, adoption: { kind: 'adopted', legacyPath: legacy } }
    }
    // Why no marker and no fallback: the copy is retried on the next read, which is the retry a
    // settings pane offers, and the pre-rename copy is left exactly where it is.
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(
      `[orca] Could not move ${[segment, ...segments].join('/')} into ${HOME_DIRECTORY_NAME}, so it is not being used. Its copy in ${LEGACY_HOME_DIRECTORY_NAME} is untouched.`,
      error
    )
    return { path: current, adoption: { kind: 'failed', legacyPath: legacy, reason } }
  }
}

/** {@link resolveLegacyHomeStoreIn} for the real home directory. */
export function resolveLegacyHomeStore(
  segment: string,
  ...segments: string[]
): LegacyHomeStoreResolution {
  return resolveLegacyHomeStoreIn(homedir(), segment, ...segments)
}

/** {@link resolveLegacyHomeStoreIn}'s path, for callers that report nothing to a settings pane. */
export function adoptLegacyHomeStoreIn(
  home: string,
  segment: string,
  ...segments: string[]
): string {
  return resolveLegacyHomeStoreIn(home, segment, ...segments).path
}

function markAdoptionDecided(marker: string): void {
  try {
    mkdirSync(dirname(marker), { recursive: true })
    writeFileSync(marker, ADOPTION_DECIDED, { flag: 'wx' })
  } catch (error) {
    // Why not fatal: an unwritable marker costs one redundant adoption check next run, while throwing
    // here would take the store's own caller down over a bookkeeping file. EEXIST is the normal case —
    // another process decided the same store first.
    if (errorCode(error) !== 'EEXIST') {
      console.warn('[orca] Could not record that a pre-rename store has been considered', error)
    }
  }
}

/**
 * Record that a decision was made but the pre-rename copy was not imported.
 *
 * Why a record at all, when the outcome is recomputed on every read: deleting this build's copy after
 * the user re-entered credentials would otherwise make the store "missing" again, and the next read
 * would silently adopt an official install's copy — the resurrection the decided marker prevents.
 */
function recordUnimportedCopy(
  marker: string,
  adoption: Extract<LegacyHomeStoreAdoption, { kind: 'failed' }>
): void {
  try {
    mkdirSync(dirname(marker), { recursive: true })
    writeFileSync(
      marker,
      JSON.stringify({
        kind: 'unimported',
        legacyPath: adoption.legacyPath,
        reason: adoption.reason
      }),
      { flag: 'wx' }
    )
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') {
      console.warn('[orca] Could not record an un-imported pre-rename store', error)
    }
  }
}

const ADOPTION_DECIDED = ''

/** The recorded outcome, or null when this store has not been decided yet. */
function readAdoptionRecord(marker: string): LegacyHomeStoreAdoption | null {
  let text: string
  try {
    text = readFileSync(marker, 'utf8')
  } catch (error) {
    // Why only a missing marker is undecided: a marker that exists but cannot be read still records a
    // decision, and adopting anyway would take an official install's copy. ENOTDIR is "missing" too —
    // the fork's home itself is a file, so no marker can exist under it.
    const code = errorCode(error)
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : { kind: 'decided' }
  }
  if (text === ADOPTION_DECIDED) {
    return { kind: 'decided' }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'kind' in parsed &&
      parsed.kind === 'unimported' &&
      'legacyPath' in parsed &&
      typeof parsed.legacyPath === 'string' &&
      'reason' in parsed &&
      typeof parsed.reason === 'string'
    ) {
      return { kind: 'failed', legacyPath: parsed.legacyPath, reason: parsed.reason }
    }
  } catch {
    // An unreadable record reads as decided: the marker's presence is the decision.
  }
  // A marker this build cannot parse was written by something else; treat it as decided so nothing is
  // adopted over this build's copy.
  return { kind: 'decided' }
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

/**
 * A recorded un-imported copy is worth reporting only while there is still a copy to import.
 *
 * Why re-derive the reason: the record was written when both copies existed, so its text stops being true
 * once one of them is deleted — and a settings pane that keeps showing a false reason forever is worse
 * than silence.
 */
function stillWorthReporting(
  recorded: LegacyHomeStoreAdoption,
  current: string
): LegacyHomeStoreAdoption {
  if (recorded.kind !== 'failed') {
    return recorded
  }
  if (!existsSync(recorded.legacyPath)) {
    return { kind: 'decided' }
  }
  return {
    kind: 'failed',
    legacyPath: recorded.legacyPath,
    reason: existsSync(current)
      ? `${current} already exists, so the copy in ${LEGACY_HOME_DIRECTORY_NAME} was not imported`
      : `${current} is missing, so the copy in ${LEGACY_HOME_DIRECTORY_NAME} was left where it is`
  }
}

/** {@link adoptLegacyHomeStoreIn} for the real home directory. */
export function adoptLegacyHomeStore(segment: string, ...segments: string[]): string {
  return adoptLegacyHomeStoreIn(homedir(), segment, ...segments)
}

function adoptLegacyCopy(legacy: string, current: string): void {
  mkdirSync(dirname(current), { recursive: true })
  sweepAbandonedStaging(dirname(current), basename(current))
  // Why every copy is staged then renamed, files included: a crash mid-copy otherwise leaves a
  // truncated file that the next run adopts as complete, and a half-copied credential that cannot be
  // decrypted is indistinguishable from one an official install wrote.
  const staging = `${current}.migrating-${process.pid}`
  rmSync(staging, { recursive: true, force: true })
  try {
    if (statSync(legacy).isDirectory()) {
      cpSync(legacy, staging, { recursive: true })
    } else {
      // Why copyFileSync: it carries the source's permissions, so a 0600 credential stays 0600.
      copyFileSync(legacy, staging)
    }
    renameSync(staging, current)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * Remove staging left by a run that died mid-copy.
 *
 * Why this matters more than the disk space: a staged directory is a full copy of a credential store,
 * including the tokens, and it is named after a process id that will never run again.
 */
function sweepAbandonedStaging(directory: string, baseName: string): void {
  try {
    for (const entry of readdirSync(directory)) {
      if (entry.startsWith(`${baseName}.migrating-`) && !entry.endsWith(`-${process.pid}`)) {
        rmSync(join(directory, entry), { recursive: true, force: true })
      }
    }
  } catch {
    // A directory we cannot list is one we cannot clean; the copy below still has to run.
  }
}
