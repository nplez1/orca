// The unit gate records one verdict per (revision, allowlist) under the repository's shared git dir,
// and two readers depend on it: `local/gate-unit.mjs`, which writes and reuses it, and
// `local/open-pr.mjs`, which refuses to open a PR for a revision with no PASS on record. A verdict
// only one script can find is advisory, which is what this file exists to stop.
//
// Both verdicts are read the same way here: a verdict keyed by exact revision is voided by the manifest
// commit that follows a review, so a lookup walks back over the commits the review gate already calls
// neutral — docs and the review's own record. The lint gate records its markers beside these.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, isAbsolute, resolve } from 'node:path'
import { lintVerdictRevisions, readLintVerdict } from './gate-lint-verdict.mjs'
import { reviewNeutralOnly } from './release-review-gate.mjs'

/**
 * What a verdict depends on besides the revision and the allowlist: the scripts that decide it, the
 * bun pin the native classes depend on, and the toolchains installed. Why the toolchains are here:
 * a bun or node upgrade moves the `sqlite-binding` and `host-toolchain` classes without moving HEAD,
 * so a cached PASS would describe a runtime the machine no longer has.
 */
export const GATE_INPUT_PATHS = [
  'local/gate-unit.mjs',
  'local/unit-gate-judgement.mjs',
  // Why the shared matcher: it decides what the verdict absorbs, so a change to it changes the answer.
  'local/lib/known-red.mjs',
  'local/unit-lane-files.mjs',
  'local/unit-suite-run.mjs',
  'local/gate-flake-coupling.mjs',
  // Why the selector's file list and its predicate are here: the flake waiver derives its setup files
  // from the first and its runtime-entry-point rule from the second, so a tree whose answer differs from
  // the commit's (an in-progress sync, `--allow-dirty`) must not reuse a verdict.
  'config/scripts/ci/unit-selection/dependency-graph/ci-unit-files.mjs',
  'config/scripts/ci/unit-selection/ci-unit-selection.mjs',
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
 *
 * `behind` is the path list from `governingCachedVerdict`: a verdict on a docs-only ancestor is a
 * verdict on this revision, the same rule the review and lint gates apply to their own records.
 */
export function cachedVerdictProblem(cached, { revision, gateInputs, behind = null }) {
  const governs =
    cached?.revision === revision ||
    (Array.isArray(behind) && behind.length > 0 && reviewNeutralOnly(behind))
  if (!governs) {
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
export function verdictRecordProblem(
  { allowDirty, vitestArgs },
  result,
  { headNow, treeClean, behind = null }
) {
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
  // Why neutral commits are exempt: a manifest or doc committed mid-run (session entry #709) voided a
  // completed 25-minute run and forced the re-run this cache exists to prevent.
  const neutral = Array.isArray(behind) && behind.length > 0 && reviewNeutralOnly(behind)
  if (headNow !== result.revision && !neutral) {
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

/** The default git reader: every caller passes its own so the lookup runs in the tree it means. */
function gitText(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 24 })
}

/** Why bounded: a gate is never more than a day of commits behind the revision it cleared. */
const NEUTRAL_WALK_DEPTH = 25

/** `revision`'s ancestors, newest first, or [] when git cannot answer. */
export function recentRevisions(git, revision, depth = NEUTRAL_WALK_DEPTH) {
  let out
  try {
    out = git(['rev-list', `--max-count=${String(depth)}`, revision])
  } catch {
    return []
  }
  return typeof out === 'string' ? out.split('\n').filter(Boolean).slice(1) : []
}

/** The paths `git diff --name-only from to`, or null when git cannot answer (a revision it lacks). */
export function pathsBetweenRevisions(git, from, to) {
  if (!from || !to) {
    return null
  }
  if (from === to) {
    return []
  }
  let out
  try {
    out = git(['diff', '--name-only', from, to])
  } catch {
    return null
  }
  return typeof out === 'string' ? out.split('\n').filter(Boolean) : null
}

/**
 * The newest of `candidates` whose commits to `revision` are all review-neutral, with the paths behind.
 *
 * Why the walk lives in this module: a verdict is cached per revision, so deciding whether an older one
 * still governs is a question about this cache, and the git readers it needs are here. The predicate is
 * `reviewNeutralOnly` from `release-review-gate.mjs`, so the review, lint and unit gates cannot drift
 * apart on what "neutral" means.
 */
export function neutralReachable({ revision, candidates, pathsBetween }) {
  if (!revision) {
    return null
  }
  for (const candidate of candidates) {
    if (!candidate || candidate === revision) {
      continue
    }
    const behind = pathsBetween(candidate, revision)
    if (behind === null || !reviewNeutralOnly(behind)) {
      continue
    }
    return { revision: candidate, behind }
  }
  return null
}

/**
 * Why the body is checked and not just the file name: a cache file whose `revision` field names another
 * revision is a damaged record, and reusing it would certify a run that is not this one.
 */
function verdictNamed(cacheDir, revision, fingerprint) {
  const verdict = readCachedVerdict(cacheDir, revision, fingerprint)
  return verdict && verdict.revision === revision ? verdict : null
}

/**
 * The cached verdict that governs `revision`: its own, or the newest neutral ancestor's.
 * `{ verdict, behind }`, or null when nothing governs it.
 *
 * Why: verdicts are keyed by exact revision, so committing the manifest after a 25-minute suite voided
 * it and forced a re-run — while the review gate already accepts that same class of commit.
 */
export function governingCachedVerdict({
  cacheDir,
  revision,
  fingerprint,
  git = gitText,
  depth = NEUTRAL_WALK_DEPTH
}) {
  if (!cacheDir || !revision || !fingerprint) {
    return null
  }
  const own = verdictNamed(cacheDir, revision, fingerprint)
  if (own) {
    return { verdict: own, behind: [] }
  }
  const candidates = recentRevisions(git, revision, depth).filter(
    (sha) => verdictNamed(cacheDir, sha, fingerprint) !== null
  )
  const reachable = neutralReachable({
    revision,
    candidates,
    pathsBetween: (ancestor, head) => pathsBetweenRevisions(git, ancestor, head)
  })
  if (!reachable) {
    return null
  }
  const verdict = verdictNamed(cacheDir, reachable.revision, fingerprint)
  return verdict ? { verdict, behind: reachable.behind } : null
}

/** Why one message for both boundaries: the review prepare and the dispatch refuse for these reasons. */
export function unitGatePassProblem(verdict) {
  if (!verdict) {
    return 'no cached unit-gate verdict'
  }
  if (verdict.clean !== true) {
    return `the cached verdict @${String(verdict.revision).slice(0, 10)} was recorded on a dirty tree`
  }
  if (verdict.exitCode !== 0) {
    return `the cached verdict @${String(verdict.revision).slice(0, 10)} FAILED (${verdict.counts?.failed ?? '?'} failing case(s))`
  }
  return null
}

/**
 * Why a refusal and not a crash: a gate that has not run is the failure this boundary exists to catch,
 * so the answer names the one command that fixes it.
 */
export function unitVerdictProblem({ cacheDir, revision, allowlistPath, git = gitText }) {
  let fingerprint
  try {
    fingerprint = allowlistFingerprint(readFileSync(allowlistPath))
  } catch (error) {
    return `cannot read ${allowlistPath}, so no unit verdict can be checked: ${error.message}`
  }
  const problem = unitGatePassProblem(
    governingCachedVerdict({ cacheDir, revision, fingerprint, git })?.verdict
  )
  return problem
    ? `${problem} for ${revision.slice(0, 12)} or a docs-only ancestor; run it first: orca-queue node local/gate-unit.mjs`
    : null
}

/**
 * The same question for lint's markers: a full, clean PASS for `revision` or for a neutral ancestor.
 * Null when it is green, otherwise the reason plus the command.
 */
export function lintVerdictProblem({ commonDir, revision, git = gitText }) {
  const own = readLintVerdict(commonDir, revision)
  if (own?.allPassed === true) {
    return null
  }
  if (own) {
    return `lint FAILED on ${revision.slice(0, 12)} (${(own.failed ?? []).join(', ') || 'no step ids recorded'}); fix it, then: orca-queue node local/gate-lint.mjs`
  }
  const passing = new Set(
    lintVerdictRevisions(commonDir).filter(
      (sha) => readLintVerdict(commonDir, sha)?.allPassed === true
    )
  )
  const reachable = neutralReachable({
    revision,
    candidates: recentRevisions(git, revision).filter((sha) => passing.has(sha)),
    pathsBetween: (ancestor, head) => pathsBetweenRevisions(git, ancestor, head)
  })
  return reachable
    ? null
    : `no green lint verdict for ${revision.slice(0, 12)} or a docs-only ancestor; run it first: orca-queue node local/gate-lint.mjs`
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
