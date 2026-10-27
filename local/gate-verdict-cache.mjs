// The unit gate records one verdict per (revision, allowlist) under the repository's shared git dir,
// and two readers depend on it: `local/gate-unit.mjs`, which writes and reuses it, and
// `local/open-pr.mjs`, which refuses to open a PR for a revision with no PASS on record. A verdict
// only one script can find is advisory, which is what this file exists to stop.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, isAbsolute, resolve } from 'node:path'

/**
 * What a verdict depends on besides the revision and the allowlist: the scripts that decide it, the
 * bun pin the native classes depend on, and the toolchains installed. Why the toolchains are here:
 * a bun or node upgrade moves the `sqlite-binding` and `host-toolchain` classes without moving HEAD,
 * so a cached PASS would describe a runtime the machine no longer has.
 */
export const GATE_INPUT_PATHS = [
  'local/gate-unit.mjs',
  'local/gate-flake-coupling.mjs',
  'local/gate-verdict-cache.mjs',
  'local/check-unit-shard-verdict.mjs',
  'config/.bun-version'
]

export function unitGateCacheDir(gitDir) {
  return join(gitDir, 'orca-gate')
}

/**
 * One cache per repository, not per worktree. `--absolute-git-dir` answers with the *worktree's* git
 * dir (`.git/worktrees/<name>`), so the same revision gated in two worktrees ran the full suite
 * twice — and the release gate is 25 minutes. `--git-common-dir` is the shared `.git`, which is the
 * right key for a cache whose entries are already keyed by revision, allowlist and toolchain. A
 * relative answer (plain `--git-common-dir` in a worktree) is resolved against the root, not the cwd.
 */
export function resolvedGateCacheDir({ commonDir, gitDir, root }) {
  const base = commonDir || gitDir || join(root, '.git')
  return unitGateCacheDir(isAbsolute(base) ? base : resolve(root, base))
}

export function allowlistFingerprint(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

/** The versions of the toolchains actually on this machine, as the suite will find them. */
export function toolchainVersions() {
  const probe = (program) => {
    const result = spawnSync(program, ['--version'], { encoding: 'utf8' })
    return result.status === 0 ? result.stdout.trim() : 'unavailable'
  }
  return { node: probe('node'), bun: probe('bun') }
}

/** `files` is `{ path: text }` for `GATE_INPUT_PATHS`; both readers must pass the same spelling. */
export function gateInputsFingerprint({ files, toolchain }) {
  return createHash('sha256')
    .update(JSON.stringify({ files, toolchain }))
    .digest('hex')
    .slice(0, 12)
}

/**
 * Why a cached verdict is refused: it has to be about this revision, recorded on a clean tree, and
 * against the same toolchain. `--allow-dirty` and a forwarded selector never reach here — the cache
 * is not read at all in those modes.
 */
export function cachedVerdictProblem(cached, { revision, gateInputs }) {
  if (cached?.revision !== revision) {
    return 'it does not name this revision'
  }
  if (cached?.clean !== true) {
    return 'it does not prove a clean run'
  }
  if (cached.gateInputs !== gateInputs) {
    return 'it was produced with different gate inputs (the gate scripts, config/.bun-version, or the installed node and bun)'
  }
  return null
}

/**
 * Why a run is not recorded: a dirty tree or a forwarded selector is not the revision, a run that did
 * not complete says nothing about it (one loaded machine's timeout must not become the verdict until
 * someone passes --no-cache), and a commit or edit made during the run leaves a verdict that describes
 * neither HEAD nor the tree it claims.
 */
export function verdictRecordProblem({ allowDirty, vitestArgs }, result, { headNow, treeClean }) {
  if (allowDirty) {
    return '--allow-dirty was passed'
  }
  if (vitestArgs.length > 0) {
    return 'forwarded selectors ran a subset of the suite'
  }
  if (result.clean !== true) {
    return 'the run recorded itself as dirty'
  }
  if (result.outcome !== 'complete') {
    return `the run ended as "${result.outcome}", which says nothing about the revision`
  }
  if (headNow !== result.revision) {
    return 'HEAD moved during the run'
  }
  if (!treeClean) {
    return 'the tree changed during the run'
  }
  return null
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
  const selectors = result.selectors ?? []
  // Why the scope is on the line: this is the shape AGENTS.md quotes as gate 1, so a run over a
  // changed-file subset must not be quotable as one.
  const scope = selectors.length > 0 ? `, partial: -- ${selectors.join(' ')}` : ''
  const caveat =
    selectors.length > 0
      ? ' — NOT a gate-1 verdict: forwarded selectors ran a subset of the suite'
      : ''
  return `Unit gate @${result.revision.slice(0, 10)} (${result.clean ? 'clean' : 'dirty'}${scope}): ${result.exitCode === 0 ? 'PASS' : 'FAIL'} — ${parts.join('; ')}; ${(result.elapsedMs / 1000).toFixed(0)} s${caveat}`
}
