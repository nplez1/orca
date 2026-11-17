// A per-tree PASS cache for the slow post-sync rows (the typecheck, the native build).
//
// Why: the last release ran post-sync 30 times, and `pnpm tc` inside every run was most of the 86
// minutes, re-proving trees it had already proven. A pass is a property of the content it ran on, so it
// is keyed on that content — HEAD's tree plus the uncommitted diff plus every untracked file — and on the
// toolchain and the installed dependency set. A FAIL is never recorded: a red row must be re-run to be
// believed fixed.
//
// The record shape and its acceptance test are the unit gate's (`local/gate-verdict-cache.mjs`), with the
// content key in place of the revision. Read-only on the repository: hashing uses no `-w`.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  cachedVerdictPath,
  cachedVerdictProblem,
  readCachedVerdict
} from '../../gate-verdict-cache.mjs'
import { STATUS, git, gitText, repoRoot, syncOutputDir } from './run.mjs'

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

/** What pnpm rewrites when it installs. Both are gitignored, so the content key cannot see them. */
const INSTALL_STATE = ['node_modules/.modules.yaml', 'node_modules/.pnpm/lock.yaml']

/**
 * The installed dependency set a typecheck compiles against. Without it a merge that lands a new
 * lockfile caches a pass made against the old install and hands it back after `pnpm install`.
 */
export function dependencyState() {
  return INSTALL_STATE.map((file) => {
    let text = null
    try {
      text = readFileSync(path.join(repoRoot(), file), 'utf8')
    } catch {
      return `${file}:absent`
    }
    return `${file}:${sha256(text).slice(0, 16)}`
  }).join(',')
}

/**
 * The content `paths` (the whole tree when empty) has right now, or null when it cannot be read — no
 * key, no cache. The diff is against HEAD, so staged and unstaged edits both count.
 */
export function worktreeFingerprint(paths = []) {
  const head =
    paths.length === 0
      ? gitText(['rev-parse', 'HEAD^{tree}'])
      : gitText(['ls-tree', 'HEAD', '--', ...paths])
  const diff = git(['diff', 'HEAD', '--binary', '--no-ext-diff', '--no-color', '--', ...paths])
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths])
  if (head === null || !diff.ok || !untracked.ok) {
    return null
  }
  const files = untracked.stdout.split('\0').filter(Boolean).sort()
  let blobs = ''
  if (files.length > 0) {
    const hashed = git(['hash-object', '--stdin-paths'], { input: `${files.join('\n')}\n` })
    if (!hashed.ok) {
      return null
    }
    blobs = hashed.stdout
  }
  return sha256(JSON.stringify({ head, diff: sha256(diff.stdout), files, blobs }))
}

const cacheDir = (name) => path.join(syncOutputDir(), 'cache', name)

/**
 * Run `check` unless this exact content already passed it with the same `inputs` (command, toolchain).
 * One entry per row: "the last passing run" is the whole memory, so a stale entry cannot pile up.
 */
export function withPassCache({ name, paths = [], inputs, noCache = false, check }) {
  const gateInputs = sha256(JSON.stringify(inputs)).slice(0, 12)
  const before = worktreeFingerprint(paths)
  const dir = cacheDir(name)
  if (before !== null && !noCache) {
    const cached = readCachedVerdict(dir, before, gateInputs)
    if (
      cached !== null &&
      cachedVerdictProblem(cached, { revision: before, gateInputs }) === null
    ) {
      return {
        status: STATUS.passed,
        summary: `clean (cached: this exact content passed at ${cached.recordedAt} in ${Math.round(cached.elapsedMs / 1000)} s; --no-cache re-runs it)`,
        details: [
          `content key ${before.slice(0, 12)}${paths.length ? ` over ${paths.join(', ')}` : ''}`
        ]
      }
    }
  }
  const started = Date.now()
  const outcome = check()
  const elapsedMs = Date.now() - started
  if (outcome.status !== STATUS.passed || before === null) {
    return outcome
  }
  // An edit made while the check ran leaves a pass that describes neither tree.
  if (worktreeFingerprint(paths) !== before) {
    return {
      ...outcome,
      details: [...(outcome.details ?? []), 'not cached: the tree changed during the run']
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const record = {
      revision: before,
      gateInputs,
      clean: true,
      inputs,
      elapsedMs,
      recordedAt: new Date().toISOString()
    }
    writeFileSync(
      cachedVerdictPath(dir, before, gateInputs),
      `${JSON.stringify(record, null, 2)}\n`
    )
  } catch {
    // A cache that cannot be written costs the next run its time, never its verdict.
  }
  return outcome
}
