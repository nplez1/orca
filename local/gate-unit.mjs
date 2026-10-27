#!/usr/bin/env node
/**
 * Unit-gate verdict for this fork.
 *
 * Runs the full unit suite once and turns it into a verdict: a failure listed in
 * `local/unit-known-red.json` is reported but does not fail the gate, a failure outside it does.
 * Anything the run cannot account for fails closed: a non-zero exit that no failure and no unhandled
 * error explains, and a declared unhandled count that does not match what could be read — the rule
 * `decideUnitShardVerdict` applies to a CI shard.
 *
 * The verdict is cached per (revision, allowlist) and records the gate inputs it was computed against
 * — its own scripts, `config/.bun-version`, and the installed node and bun — so re-running the gate on
 * a revision that has not changed returns immediately, which is what stops the
 * run-seven-times-per-session pattern the 2026-10-14 session log recorded, while a verdict from a
 * different toolchain is not reused.
 *
 * Two things it runs beyond the suite. It runs the set upstream's own unit lane runs, by setting the
 * switch `config/vitest.config.ts` reads for `UNIT_EXCLUDE` rather than `defaultExclude`: a file
 * upstream quarantines is not a red this fork owes an allowlist entry for. And it runs the
 * fork-local `node --test` files, which sit outside `UNIT_INCLUDE` and so were in no lane at all.
 *
 * Upstream's own runs never call this: `.github/workflows/unit-tests.yml` keeps Vitest's exit code,
 * and `local/check-unit-shard-verdict.mjs` stays the per-shard CI verdict. This is the local gate
 * described in `AGENTS.md` § Release gate.
 *
 * Usage: node local/gate-unit.mjs [--allowlist PATH] [--no-cache] [--allow-dirty]
 *                                 [--timeout-ms N] [-- <vitest args>]
 *
 * Exit: 0 pass, 1 fail, 2 usage or environment problem.
 */
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  closeSync,
  openSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { UNIT_EXCLUDE, UNIT_INCLUDE } from '../config/scripts/ci-unit-files.mjs'
import { TOLERATED_UNHANDLED_ERROR, collectUnhandledErrors } from './check-unit-shard-verdict.mjs'
import { flakeWaiver } from './gate-flake-coupling.mjs'
import {
  GATE_INPUT_PATHS,
  allowlistFingerprint,
  cachedVerdictPath,
  cachedVerdictProblem,
  formatVerdict,
  gateInputsFingerprint,
  toolchainVersions,
  resolvedGateCacheDir,
  verdictRecordProblem
} from './gate-verdict-cache.mjs'
import {
  NO_RERUN,
  allowlistEntries,
  collectCases,
  collectedQuarantinedFiles,
  declaredUnhandledMismatch,
  judge,
  judgeUnhandled,
  prunableEntries,
  quarantinedEntryProblems,
  rerunReportsFor,
  reproducedFailures,
  unexplainedSuiteExit
} from './unit-gate-judgement.mjs'

const ROOT = resolve(import.meta.dirname, '..')
/** Why this switch: the unit and PR workflows set it, and it is what makes `config/vitest.config.ts`
 *  apply upstream's `UNIT_EXCLUDE` instead of `defaultExclude`. */
const UNIT_LANE_ENV = { ORCA_BALANCE_UNIT_SHARDS: '1' }
/** Why: `config/vitest.config.ts` records dependencies only when `CI` is unset, so upstream's lane runs
 *  without it. With it on, an upstream fire-and-forget `import()` still pending when a file ends is
 *  reported as `EnvironmentTeardownError: Cannot load …` against the next file (LOCAL-PATCHES.md,
 *  2026-10-25 sync). Narrower than setting `CI`, which other suites read for their own behaviour. */
const UNIT_LANE_ARGS = ['--experimental.recordDependencies=false']
/** `local/` is outside `UNIT_INCLUDE` by upstream's definition, so nothing else would run these. */
const FORK_TEST_INCLUDE = ['local/**/*.test.mjs']
const FORK_TEST_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_ALLOWLIST = join(ROOT, 'local', 'unit-known-red.json')
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000
const MAX_SUMMARY_LIST = 12
const RUN_VITEST = join(ROOT, 'config', 'scripts', 'run-vitest.mjs')

function usage() {
  return 'usage: node local/gate-unit.mjs [--allowlist PATH] [--no-cache] [--allow-dirty] [--timeout-ms N] [-- <vitest args>]'
}

function parseArgs(argv) {
  const options = {
    allowlist: DEFAULT_ALLOWLIST,
    cache: true,
    allowDirty: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    vitestArgs: []
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') {
      options.vitestArgs = argv.slice(index + 1)
      break
    }
    if (arg === '--allowlist') {
      options.allowlist = resolve(argv[(index += 1)] ?? '')
    } else if (arg === '--no-cache') {
      options.cache = false
    } else if (arg === '--allow-dirty') {
      options.allowDirty = true
    } else if (arg === '--timeout-ms') {
      options.timeoutMs = Number(argv[(index += 1)])
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    } else {
      console.error(`unknown argument: ${arg}\n${usage()}`)
      process.exit(2)
    }
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    console.error('--timeout-ms must be a positive integer')
    process.exit(2)
  }
  return options
}

function git(args) {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  return result.status === 0 ? result.stdout.trim() : null
}

/** Why: a verdict is about a revision, so an edited tree has no revision to attach it to. */
function requireCleanTree(allowDirty) {
  const dirty = git(['status', '--porcelain'])
  if (dirty === null) {
    console.error(`cannot read git status in ${ROOT}`)
    process.exit(2)
  }
  if (dirty && !allowDirty) {
    console.error(
      `working tree is dirty — commit the revision being gated, or pass --allow-dirty:\n${dirty}`
    )
    process.exit(2)
  }
}

function readJsonFile(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    console.error(`cannot read ${what} at ${path}: ${error.message}`)
    process.exit(2)
  }
}

/**
 * The file is inside the branch's own diff when it appears between the merge-base and HEAD. Without
 * a resolvable base the answer is `unknown`, and a flaky pass is never waived on `unknown`.
 *
 * Why an empty diff is not a resolved one: a sync merges upstream *onto* the release line, so
 * `merge-base(nplez1/main, HEAD)` is HEAD itself and the diff comes back empty — which waived every
 * flaky pass on a line a 556-commit merge had just built. What that merge contributed is
 * `HEAD^1..HEAD`, so that is the diff that has to judge it.
 */
export function branchDiff(runGit = git) {
  for (const base of ['nplez1/main', 'origin/nplez1/main']) {
    const mergeBase = runGit(['merge-base', base, 'HEAD'])
    if (!mergeBase) {
      continue
    }
    const files = changedSince(runGit, mergeBase)
    if (files.size > 0) {
      return { base, files }
    }
  }
  // Why the first parent and not HEAD^2: everything a merge adds to the release line is
  // `HEAD^1..HEAD`, so nothing that merge could have broken falls outside the diff.
  // Why a single-parent HEAD is included: every PR into `nplez1/main` squashes, so a landed change is
  // a one-parent commit whose diff against `nplez1/main` is empty — it IS that line. Excluding it left
  // the answer `null`, and `null` means "in the diff", so a load flake on the release line could never
  // be excused and the gate would fail on code that commit did not touch.
  const parents = (runGit(['rev-list', '--parents', '-n', '1', 'HEAD']) ?? '').split(' ')
  if (parents.length >= 2 && parents[1]) {
    const files = changedSince(runGit, parents[1])
    if (files.size > 0) {
      return { base: parents[1], files }
    }
  }
  return null
}

function changedSince(runGit, base) {
  const diff = runGit(['diff', '--name-only', '--no-renames', base, 'HEAD'])
  return new Set((diff ?? '').split('\n').filter(Boolean))
}

function runStep(label, program, args, logFd, timeoutMs, env) {
  process.stderr.write(`gate-unit: ${label}\n`)
  const started = Date.now()
  const result = spawnSync(program, args, {
    cwd: ROOT,
    // Why the merge rather than a bare env: PATH and the Bun pin have to survive the overlay.
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ['ignore', logFd, logFd],
    timeout: timeoutMs,
    killSignal: 'SIGKILL'
  })
  const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGKILL'
  // Why the error: a spawn that never started (ENOENT, EACCES) has a null status, which would
  // otherwise read as a clean exit of zero. `timedOut` is the one error that has its own outcome.
  return {
    status: result.status,
    timedOut,
    error: timedOut ? null : (result.error?.message ?? null),
    elapsedMs: Date.now() - started
  }
}

function normalise(name) {
  return String(name ?? '').replaceAll('\\', '/')
}

/**
 * Files `UNIT_INCLUDE` collects but `UNIT_EXCLUDE` drops. Upstream's unit lane does not run them
 * either, so a red there is not this fork's to record — but a gate that quietly stopped applying the
 * exclusion would look green for the wrong reason, which is why the run is checked against this list.
 */
export function quarantinedFiles(root = ROOT) {
  const included = new Set(globSync(UNIT_INCLUDE, { cwd: root }).map(normalise))
  const collected = globSync(UNIT_INCLUDE, { cwd: root, exclude: UNIT_EXCLUDE }).map(normalise)
  const runnable = new Set(collected)
  return [...included].filter((file) => !runnable.has(file)).sort()
}

export function forkTestFiles(root = ROOT) {
  return globSync(FORK_TEST_INCLUDE, { cwd: root, exclude: ['**/node_modules/**'] })
    .map(normalise)
    .sort()
}

function runSuite({ reportPath, logPath, timeoutMs, vitestArgs, forkTests }) {
  const logFd = openSync(logPath, 'w')
  let elapsedMs = 0
  let forkTestsPassed = true
  try {
    // Why first: it costs a second and its failure would invalidate any verdict the suite produced.
    // Why its own deadline: a hung sync test must not cost the suite's whole hour before it starts.
    const forkStep =
      forkTests.length === 0
        ? { status: 0, timedOut: false, elapsedMs: 0 }
        : runStep(
            'fork-local tests',
            process.execPath,
            ['--test', ...forkTests],
            logFd,
            Math.min(timeoutMs, FORK_TEST_TIMEOUT_MS)
          )
    elapsedMs += forkStep.elapsedMs
    if (forkStep.timedOut) {
      return { outcome: 'timed-out', elapsedMs, forkTestsPassed: false }
    }
    if (forkStep.error) {
      return {
        outcome: `fork-local tests could not run: ${String(forkStep.error)}`,
        elapsedMs,
        forkTestsPassed: false
      }
    }
    if (forkStep.status !== 0) {
      return { outcome: 'fork-local tests failed', elapsedMs, forkTestsPassed: false }
    }
    // Why objects: a heterogeneous tuple array widens `label` to `string | string[]` under the
    // fork's type-aware lint, which then rejects it inside the failure template.
    for (const preparation of [
      { label: 'build:packages', program: 'pnpm', args: ['run', 'build:packages'] },
      {
        label: 'ensure native runtime',
        program: 'node',
        args: [join(ROOT, 'config', 'scripts', 'ensure-native-runtime.mjs'), '--runtime=node']
      }
    ]) {
      const step = runStep(
        preparation.label,
        preparation.program,
        preparation.args,
        logFd,
        timeoutMs
      )
      elapsedMs += step.elapsedMs
      if (step.timedOut) {
        return { outcome: 'timed-out', elapsedMs, forkTestsPassed }
      }
      if (step.error) {
        return {
          outcome: `${preparation.label} could not run: ${String(step.error)}`,
          elapsedMs,
          forkTestsPassed
        }
      }
      if (step.status !== 0) {
        return { outcome: `${preparation.label} failed`, elapsedMs, forkTestsPassed }
      }
    }
    // Why the cap line: the doubling this gate once showed (2,575 s against a 1,400 s baseline) was
    // a worker cap inherited from the shell, and a run log that named it would have said so in one
    // line instead of a per-file concurrency reconstruction.
    if (process.env.VITEST_MAX_WORKERS !== undefined) {
      process.stderr.write(`gate-unit: VITEST_MAX_WORKERS=${process.env.VITEST_MAX_WORKERS}\n`)
    }
    const suite = runStep(
      'full unit suite',
      'node',
      [
        RUN_VITEST,
        'run',
        '--config',
        'config/vitest.config.ts',
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${reportPath}`,
        ...UNIT_LANE_ARGS,
        ...vitestArgs
      ],
      logFd,
      timeoutMs,
      UNIT_LANE_ENV
    )
    elapsedMs += suite.elapsedMs
    if (suite.timedOut) {
      return { outcome: 'timed-out', elapsedMs, forkTestsPassed }
    }
    if (suite.error) {
      return {
        outcome: `the full unit suite could not run: ${String(suite.error)}`,
        elapsedMs,
        forkTestsPassed
      }
    }
    return { outcome: 'complete', status: suite.status, elapsedMs, forkTestsPassed }
  } finally {
    closeSyncSafe(logFd)
  }
}

function closeSyncSafe(fd) {
  try {
    closeSync(fd)
  } catch {
    // The descriptor is already closed when a step threw before the suite started.
  }
}

/**
 * One isolated re-run of every unexpected file in a single Vitest invocation, reported per file as
 * the tests that passed and failed inside it. Batched so N failing files pay one cold start instead
 * of N serial ones; each file still runs in its own worker, and the report is filtered by exact
 * path, so the per-file attribution of a serial re-run is unchanged.
 *
 * Why per test rather than per file: the file's own allowlisted reds still fail when it re-runs with
 * its siblings, so "the file exited non-zero" cannot tell a load flake from a real break once entries
 * are named. A missing report is not evidence of anything, so it reads as "every failure reproduced".
 */
function rerunIsolation(files, dir, timeoutMs) {
  if (files.length === 0) {
    return new Map()
  }
  const reportPath = join(dir, 'isolation-report.json')
  const logFd = openSync(join(dir, 'isolation.log'), 'a')
  try {
    const step = runStep(
      `isolation re-run ${files.length} file(s)`,
      'node',
      [
        RUN_VITEST,
        'run',
        '--config',
        'config/vitest.config.ts',
        '--reporter=json',
        `--outputFile.json=${reportPath}`,
        ...UNIT_LANE_ARGS,
        ...files
      ],
      logFd,
      timeoutMs,
      UNIT_LANE_ENV
    )
    if (step.timedOut || !existsSync(reportPath)) {
      return new Map(files.map((file) => [file, NO_RERUN]))
    }
    try {
      return rerunReportsFor(JSON.parse(readFileSync(reportPath, 'utf8')), files)
    } catch {
      // Why not readJsonFile: that exits the process, losing the summary this verdict is for.
      return new Map(files.map((file) => [file, NO_RERUN]))
    }
  } finally {
    closeSyncSafe(logFd)
  }
}

function reportResult(result) {
  console.log(formatVerdict(result))
  const forkTests = result.forkTests ?? { files: 0, passed: false }
  // Why a detail line and not part of the summary: `formatVerdict` is shared with `local/open-pr.mjs`,
  // which quotes it back in a PR body, so the one-line shape stays the shared one.
  console.log(
    `  fork-local tests (node --test): ${forkTests.files} file(s) ${forkTests.passed ? 'passed' : 'FAILED'}`
  )
  for (const item of result.known) {
    const entry = item.entry
    console.log(
      `  known (${entry.class}, ${entry.owner}${entry.flaky ? ', flaky' : ''}): ${item.failure.file} › ${item.failure.test} — ${item.failure.detail}`
    )
  }
  for (const failure of result.unexpected.slice(0, MAX_SUMMARY_LIST)) {
    const why = failure.notWaived
      ? ` — FLAKY in isolation, but ${failure.notWaived} is in this branch diff`
      : ` — ${failure.detail}`
    console.log(`  UNEXPECTED: ${failure.file} › ${failure.test}${why}`)
  }
  if (result.unexpected.length > MAX_SUMMARY_LIST) {
    console.log(`  …and ${result.unexpected.length - MAX_SUMMARY_LIST} more unexpected failure(s)`)
  }
  for (const entry of result.flaky) {
    console.log(`  FLAKY, not ours: ${entry.file} › ${entry.test}`)
  }
  for (const entry of result.stale) {
    console.log(`  stale entry (passed in this run) — prune ${entry.key}`)
  }
  for (const entry of result.unseen) {
    console.log(`  unseen entry (nothing in this run matched it) — prune or re-name: ${entry.key}`)
  }
  if (result.filtered) {
    console.log('  unseen entries are not judged when a selector filters the run')
  }
  const quarantined = result.quarantined?.files ?? []
  if (quarantined.length) {
    console.log(
      `  upstream-quarantined (UNIT_EXCLUDE, not run): ${quarantined.length} file(s) — ${quarantined.slice(0, MAX_SUMMARY_LIST).join(', ')}`
    )
    if (quarantined.length > MAX_SUMMARY_LIST) {
      console.log(`  …and ${quarantined.length - MAX_SUMMARY_LIST} more quarantined file(s)`)
    }
  }
  for (const entry of result.unhandled?.known ?? []) {
    console.log(`  known unhandled error (×${entry.count}): ${entry.headline}`)
  }
  for (const entry of result.unhandled?.blocking ?? []) {
    console.log(`  UNHANDLED (×${entry.count}): ${entry.headline}`)
  }
  for (const problem of result.problems) {
    console.log(`  blocked: ${problem}`)
  }
  if (result.logPath) {
    console.log(`  log: ${result.logPath}`)
  }
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** The gate inputs of the tree being gated; a clean tree is the revision, so this is its inputs. */
function currentGateInputs() {
  const files = {}
  for (const path of GATE_INPUT_PATHS) {
    files[path] = readText(join(ROOT, path))
  }
  return gateInputsFingerprint({ files, toolchain: toolchainVersions() })
}

function evaluate(options, { reportPath, logPath, dir }) {
  const revision = git(['rev-parse', 'HEAD'])
  if (!revision) {
    console.error(`cannot resolve HEAD in ${ROOT}`)
    process.exit(2)
  }
  const manifest = readJsonFile(options.allowlist, 'known-red allowlist')
  // Why: a forwarded selector describes a different suite, so every entry outside it matches nothing.
  // Reporting those as unseen would invite pruning an entry the full run needs.
  const fullRun = options.vitestArgs.length === 0
  const entries = allowlistEntries(manifest)
  const quarantined = quarantinedFiles()
  const forkTests = forkTestFiles()
  const run = runSuite({
    reportPath,
    logPath,
    timeoutMs: options.timeoutMs,
    vitestArgs: options.vitestArgs,
    forkTests
  })

  const problems = []
  if (run.outcome !== 'complete') {
    problems.push(`the suite did not run to completion: ${run.outcome}`)
  }
  const quarantinedSet = new Set(quarantined)
  if (forkTests.length === 0) {
    problems.push(
      'no fork-local test file matched local/**/*.test.mjs, so that lane proved nothing'
    )
  }
  problems.push(...quarantinedEntryProblems(entries, quarantinedSet))
  let report = null
  if (existsSync(reportPath)) {
    try {
      report = JSON.parse(readFileSync(reportPath, 'utf8'))
    } catch (error) {
      problems.push(`the Vitest JSON report is unreadable: ${error.message}`)
    }
  } else if (run.outcome === 'complete') {
    problems.push('no Vitest JSON report was written, so nothing proves the suite ran')
  }

  let counts = { passed: 0, failed: 0, known: 0 }
  let known = []
  let unexpected = []
  let stale = []
  let unseen = []
  if (report) {
    counts.passed = Number(report.numPassedTests) || 0
    if ((Number(report.numTotalTests) || 0) === 0) {
      problems.push('the report holds no tests, so the run cannot be judged green')
    }
    const cases = collectCases(report)
    const judged = judge(entries, cases.failures, cases.passes)
    known = judged.known
    unexpected = judged.unexpected
    stale = judged.stale
    unseen = prunableEntries(judged.unseen, report, {
      full: fullRun,
      // Why the test count: a report with no tests proves nothing about any entry.
      complete: run.outcome === 'complete' && (Number(report.numTotalTests) || 0) > 0
    })
    // Why not `numFailedTests`: it counts cases only, so a file that failed to collect would be
    // missing from it while it is very much a failure of this run.
    counts.failed = cases.failures.length
    counts.known = known.length
    // Why: a verdict that silently stopped excluding them would still look green, and the reason
    // would be a switch in a config file rather than anything about the code being shipped.
    const ranQuarantined = collectedQuarantinedFiles(report, quarantinedSet)
    if (ranQuarantined.length) {
      problems.push(
        `the run collected ${ranQuarantined.length} upstream-quarantined file(s), so UNIT_EXCLUDE did not apply: ${ranQuarantined.slice(0, MAX_SUMMARY_LIST).join(', ')}`
      )
    }
  }

  const logText = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
  const unhandled = collectUnhandledErrors(logText)
  const tolerated = unhandled.headlines.filter((headline) => headline === TOLERATED_UNHANDLED_ERROR)
  const judgedUnhandled = judgeUnhandled(
    unhandled.headlines.filter((headline) => headline !== TOLERATED_UNHANDLED_ERROR),
    manifest.unhandledErrors
  )
  for (const item of judgedUnhandled.blocking) {
    problems.push(`unhandled error (×${item.count}): ${item.headline}`)
  }
  const unhandledMismatch = declaredUnhandledMismatch(
    unhandled.declaredCount,
    unhandled.headlines.length
  )
  if (unhandledMismatch) {
    problems.push(unhandledMismatch)
  }
  const exitProblem = unexplainedSuiteExit({
    outcome: run.outcome,
    status: run.status,
    failedCount: counts.failed,
    unhandledCount: unhandled.headlines.length
  })
  if (exitProblem) {
    problems.push(exitProblem)
  }

  // A failure outside the allowlist gets an isolated re-run, all such files in one batched
  // invocation. A failure that does not come back is a load-order flake — a different claim from
  // "this change broke it" — so it is waived unless the file is in the diff. Judged per test: the
  // file's allowlisted reds still fail when it re-runs with its siblings.
  const diff = branchDiff()
  const flaky = []
  const blocking = []
  const unexpectedByFile = new Map()
  for (const failure of unexpected) {
    const list = unexpectedByFile.get(failure.file) ?? []
    list.push(failure)
    unexpectedByFile.set(failure.file, list)
  }
  const reruns = rerunIsolation([...unexpectedByFile.keys()], dir, options.timeoutMs)
  for (const [file, failures] of unexpectedByFile) {
    const rerun = reruns.get(file) ?? NO_RERUN
    const reproduced = new Set(reproducedFailures(failures, rerun).map((failure) => failure.test))
    // Why not `diff.files.has(file)`: a branch that changes `src/x.ts`, the module beside a test, an
    // imported module, or the harness every test runs under breaks `x.test.ts` without the test file
    // itself being in the diff.
    const waiver = flakeWaiver(file, diff?.files ?? null)
    for (const failure of failures) {
      if (reproduced.has(failure.test)) {
        blocking.push(failure)
      } else if (waiver.inDiff) {
        // Why the reason travels with the failure: a per-test row that passed in isolation and was
        // still refused reads as a plain UNEXPECTED failure unless the coupling says why.
        blocking.push({
          ...failure,
          notWaived: waiver.matched ?? 'the branch diff could not be resolved'
        })
      } else {
        flaky.push({ file, test: failure.test })
      }
    }
  }

  const exitCode = blocking.length === 0 && problems.length === 0 ? 0 : 1
  return {
    revision,
    clean: !options.allowDirty,
    // Why on the verdict: a subset run prints the same summary shape as gate 1 otherwise.
    selectors: options.vitestArgs,
    outcome: run.outcome,
    counts,
    known,
    unexpected: blocking,
    flaky,
    stale,
    unseen,
    filtered: !fullRun,
    problems,
    unhandled: {
      tolerated: tolerated.length,
      known: judgedUnhandled.known.map((entry) => ({
        headline: entry.headline,
        count: entry.count
      })),
      blocking: judgedUnhandled.blocking
    },
    elapsedMs: run.elapsedMs ?? 0,
    forkTests: { files: forkTests.length, passed: run.forkTestsPassed !== false },
    quarantined: { count: quarantined.length, files: quarantined },
    logPath,
    diffBase: diff?.base ?? null,
    exitCode,
    recordedAt: new Date().toISOString()
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  requireCleanTree(options.allowDirty)
  const allowlistHash = allowlistFingerprint(readFileSync(options.allowlist))
  const gateInputs = currentGateInputs()
  const revision = git(['rev-parse', 'HEAD'])
  // Why the common dir and not the worktree's git dir: a linked worktree's `.git` is a file, and
  // `--absolute-git-dir` answers with `.git/worktrees/<name>`, so each worktree kept its own copy of a
  // cache keyed by revision. Gating the same SHA twice cost a full suite run.
  const cacheDir = resolvedGateCacheDir({
    commonDir: git(['rev-parse', '--path-format=absolute', '--git-common-dir']),
    gitDir: git(['rev-parse', '--absolute-git-dir']),
    root: ROOT
  })
  const cachePath = revision ? cachedVerdictPath(cacheDir, revision, allowlistHash) : null
  // Why the reuse guard is here and not inside the check: `--no-cache` is the documented way out of a
  // damaged cache file, so it must not parse one to refuse it, and `--allow-dirty` asks about the tree
  // rather than about HEAD, so a verdict recorded for HEAD cannot answer it.
  const mayReuse = options.cache && options.vitestArgs.length === 0 && !options.allowDirty

  if (mayReuse && cachePath && existsSync(cachePath)) {
    const cached = readJsonFile(cachePath, 'cached verdict')
    const problem = cachedVerdictProblem(cached, { revision, gateInputs })
    if (problem) {
      console.log(`gate-unit: ignoring the cached verdict — ${problem}`)
    } else {
      console.log(
        'gate-unit: cached verdict for this revision, allowlist and gate inputs (pass --no-cache to re-run)'
      )
      reportResult(cached)
      process.exit(cached.exitCode)
    }
  }
  if (options.allowDirty) {
    console.log('gate-unit: --allow-dirty, so this verdict is not recorded — it is not about HEAD')
  }
  if (options.vitestArgs.length > 0) {
    console.log(
      `gate-unit: forwarded selectors -- ${options.vitestArgs.join(' ')} run a subset of the suite; not a gate verdict, and not recorded`
    )
  }

  const dir = mkdtempSync(join(tmpdir(), 'orca-gate-'))
  const result = evaluate(options, {
    dir,
    reportPath: join(dir, 'report.json'),
    logPath: join(dir, 'run.log')
  })

  const verdict = { ...result, gateInputs }
  // Why re-read HEAD and the tree: the suite takes twenty minutes, and a commit or edit made in that
  // window would otherwise be recorded as a verdict on the revision it replaced. Why `--no-cache`
  // still records: a stale or environmental FAIL in the cache could otherwise never be replaced.
  const recordProblem =
    result.revision === revision
      ? verdictRecordProblem(options, result, {
          headNow: git(['rev-parse', 'HEAD']),
          treeClean: git(['status', '--porcelain']) === ''
        })
      : 'HEAD moved before the run recorded its revision'
  if (recordProblem) {
    console.log(`gate-unit: not recording this verdict — ${recordProblem}`)
  } else if (cachePath) {
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(cachePath, `${JSON.stringify(verdict, null, 2)}\n`)
  }
  reportResult(verdict)
  process.exit(verdict.exitCode)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
}
