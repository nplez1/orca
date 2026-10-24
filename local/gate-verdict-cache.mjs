// The unit gate records one verdict per (revision, allowlist) under the worktree's git dir, and
// two readers depend on it: `local/gate-unit.mjs`, which writes and reuses it, and
// `local/open-pr.mjs`, which refuses to open a PR for a revision with no PASS on record. A verdict
// only one script can find is advisory, which is what this file exists to stop.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function unitGateCacheDir(gitDir) {
  return join(gitDir, 'orca-gate')
}

export function allowlistFingerprint(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

export function cachedVerdictPath(cacheDir, revision, fingerprint) {
  return join(cacheDir, `${revision.slice(0, 12)}-${fingerprint}.json`)
}

/** Why swallow a parse error: a damaged cache file is a missing verdict, not a passing one. */
export function readCachedVerdict(cacheDir, revision, fingerprint) {
  const path = cachedVerdictPath(cacheDir, revision, fingerprint)
  if (!existsSync(path)) {
    return null
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** One line, the shape a PR body quotes. */
export function formatVerdict(result) {
  const counts = result.counts
  const unhandledBlocking = result.unhandled?.blocking?.length ?? 0
  const parts = [
    `${counts.passed} passed`,
    `${counts.failed} failed (${counts.known} allowlisted, ${result.unexpected.length} unexpected)`,
    `${result.flaky.length} flaky re-run passed`,
    `${unhandledBlocking} unhandled error headline(s)`
  ]
  return `Unit gate @${result.revision.slice(0, 10)} (${result.clean ? 'clean' : 'dirty'}): ${result.exitCode === 0 ? 'PASS' : 'FAIL'} — ${parts.join('; ')}; ${(result.elapsedMs / 1000).toFixed(0)} s`
}
