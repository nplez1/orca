// Working directory the session-summary fold hands to the agent CLI.
//
// The CLI loads project instructions and config (`.claude/settings.json`, `CLAUDE.md`, `AGENTS.md`) from
// its cwd and every parent up to the filesystem root, and runs what it finds as this user with the
// transcript as its prompt. So the cwd must live somewhere no other local user can write — which a
// shared temp root is not — and must hold nothing a previous call left behind.
import { chmodSync, lstatSync, mkdirSync, readdirSync } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Stats } from 'node:fs'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { removeTree, removeTreeSync } from '../../shared/windows-transient-lock-removal'

export const SESSION_SUMMARY_FOLD_CWD_DIR_NAME = 'session-summary-fold-cwd'

/** `mkdtemp`'s suffix is exactly six alphanumerics; the sweep only ever matches that shape. */
const TRANSCRIPT_DIR_NAME = /^orca-session-summary-[A-Za-z0-9]{6}$/

/**
 * Longer than any transcript copy can live: the fetch has a 15-minute ceiling and disposes its copy
 * right after parsing, so an hour cannot reach a fetch running in another Orca instance.
 */
export const SESSION_SUMMARY_SCRATCH_MAX_AGE_MS = 60 * 60_000

/**
 * The fold's cwd, prepared for one agent call.
 *
 * Why one stable path rather than a fresh random one per call: the Claude CLI keys
 * `~/.claude/projects/<cwd>` by the working directory, so a random cwd per call would leave a
 * ~150 KB session file behind for every chunk of every fold. Emptying it instead separates
 * successive calls; the fold's concurrent chunks deliberately share the one directory.
 *
 * A userData override that points into a shared directory gives up the parent protection this
 * relies on — the leaf is verified, its ancestors are not.
 */
export function prepareSessionSummaryFoldCwd(root: string): string {
  const dir = join(root, SESSION_SUMMARY_FOLD_CWD_DIR_NAME)
  ensureOwnedDirectory(dir)
  for (const entry of readdirSync(dir)) {
    removeTreeSync(join(dir, entry))
  }
  return dir
}

/** Creates the directory private to this user, replacing anything at that path that is not. */
function ensureOwnedDirectory(dir: string): void {
  // mkdir's recursive mode succeeds silently over an existing directory, whoever created it.
  const existing = lstatIfPresent(dir)
  if (existing && (!existing.isDirectory() || !isOwnedByCurrentUser(existing))) {
    removeTreeSync(dir)
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stats = lstatSync(dir)
  if (!stats.isDirectory() || !isOwnedByCurrentUser(stats)) {
    throw new Error(`Cannot use ${dir} as the session-summary working directory.`)
  }
  // mkdir's mode is masked by the umask, and an existing directory keeps whatever it had.
  if (process.platform !== 'win32') {
    chmodSync(dir, 0o700)
  }
}

function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  }
}

function isOwnedByCurrentUser(stats: Stats): boolean {
  const uid = process.getuid?.()
  // Windows has no uid to compare; its temp and profile directories are already per-user.
  return uid === undefined || stats.uid === uid
}

export type SessionSummaryScratchSweepOptions = {
  root?: string
  now?: number
  maxAgeMs?: number
}

/**
 * Removes the transcript copies a crashed run left in the temp root. Returns how many were removed.
 *
 * Only `lstat`s, and only the exact `mkdtemp` name shape: a path another local user could have
 * planted — a symlink, or the legacy fixed `orca-session-summary` — is never followed or removed.
 */
export async function sweepStaleSessionSummaryScratchDirs(
  options: SessionSummaryScratchSweepOptions = {}
): Promise<number> {
  const root = options.root ?? tmpdir()
  const now = options.now ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? SESSION_SUMMARY_SCRATCH_MAX_AGE_MS
  const ownUid = process.getuid?.()
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return 0
  }
  let removed = 0
  for (const entry of entries) {
    if (!TRANSCRIPT_DIR_NAME.test(entry.name)) {
      continue
    }
    const path = join(root, entry.name)
    try {
      const stats = await lstat(path)
      // A symlink or file wearing our name is not ours to delete.
      if (!stats.isDirectory()) {
        continue
      }
      if (ownUid !== undefined && stats.uid !== ownUid) {
        continue
      }
      if (now - stats.mtimeMs < maxAgeMs) {
        continue
      }
      await removeTree(path)
      removed += 1
    } catch {
      // Racing another instance's own sweep is not a failure; the next sweep retries.
    }
  }
  return removed
}

let sweepStarted = false

/** Sweeps once per process, without blocking the caller on a slow temp root. */
export function sweepStaleSessionSummaryScratchDirsOnce(
  options: SessionSummaryScratchSweepOptions = {}
): void {
  if (sweepStarted) {
    return
  }
  sweepStarted = true
  void sweepStaleSessionSummaryScratchDirs(options).catch(() => {})
}
