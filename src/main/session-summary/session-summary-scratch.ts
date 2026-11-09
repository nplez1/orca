// Scratch directories the session-summary fold hands to the agent CLI as its working directory.
//
// The CLI loads project config (`.claude/settings.json` hooks, `CLAUDE.md`, `AGENTS.md`) from its cwd and
// runs it as this user, so the cwd must be a directory nobody else can pre-create or plant content in.
// `mkdtemp` creates it atomically with a random suffix and mode 0700.
import { mkdtempSync } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTree } from '../../shared/windows-transient-lock-removal'

/** mkdtemp's suffix is exactly six alphanumerics; a planted or foreign name cannot match this. */
const SCRATCH_DIR_NAME = /^orca-session-summary-[A-Za-z0-9]{6}$/

/**
 * Longer than any directory we create can live: an agent call is capped at 60 s
 * (`SOURCE_CONTROL_GENERATION_TIMEOUT_MS`) and a remote transcript fetch at 15 min, so an hour
 * cannot reach a fold running in another Orca instance.
 */
export const SESSION_SUMMARY_SCRATCH_MAX_AGE_MS = 60 * 60_000

/** A fresh, private working directory for one agent call. */
export function createSessionSummaryScratchDir(root: string = tmpdir()): string {
  return mkdtempSync(join(root, 'orca-session-summary-'))
}

export type SessionSummaryScratchSweepOptions = {
  root?: string
  now?: number
  maxAgeMs?: number
}

/**
 * Removes the scratch dirs a crashed process left behind. Returns how many were removed.
 *
 * Only `lstat`s and only the exact `mkdtemp` name shape: a path another local user could have planted
 * — a symlink, or the legacy fixed `orca-session-summary` — is never followed and never removed.
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
    if (!SCRATCH_DIR_NAME.test(entry.name)) {
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
