#!/usr/bin/env node
/**
 * Unit-gate verdict for this fork.
 *
 * Runs the full unit suite once and turns it into a verdict: a failure listed in
 * `local/unit-known-red.json` is reported but does not fail the gate, a failure outside it does.
 * The verdict is cached per (revision, allowlist), so re-running the gate on a revision that has
 * not changed returns immediately — which is what stops the run-seven-times-per-session pattern
 * the 2026-10-14 session log recorded.
 *
 * Two things it runs beyond the suite. It runs the set upstream's own unit lane runs, by setting the
 * switch `config/vitest.config.ts` reads for `UNIT_EXCLUDE` rather than `defaultExclude`: a file
 * upstream quarantines is not a red this fork owes an allowlist entry for. And it runs the
 * fork-local `node --test` files, which sit outside `UNIT_INCLUDE` and so were in no lane at all.
 *
 * Upstream's own runs never call this: `.github/workflows/unit-tests.yml` keeps Vitest's exit code,
 * and `local/check-unit-shard-verdict.mjs` stays the per-shard CI verdict. This is the local gate
 * described in `AGENTS.md` § PR gate 1.
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
import {
  allowlistFingerprint,
  cachedVerdictPath,
  formatVerdict,
  unitGateCacheDir
} from './gate-verdict-cache.mjs'
import {
  NO_RERUN,
  allowlistEntries,
  collectCases,
  collectedQuarantinedFiles,
  judge,
  judgeUnhandled,
  prunableEntries,
  quarantinedEntryProblems,
  reproducedFailures,
  reportForFile
} from './unit-gate-judgement.mjs'

const ROOT = resolve(import.meta.dirname, '..')
/** Why this switch: the unit and PR workflows set it, and it is what makes `config/vitest.config.ts`
 *  apply upstream's `UNIT_EXCLUDE` instead of `defaultExclude`. */
const UNIT_LANE_ENV = { ORCA_BALANCE_UNIT_SHARDS: '1' }
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
 */
function branchDiff() {
  for (const base of ['nplez1/main', 'origin/nplez1/main']) {
    const mergeBase = git(['merge-base', base, 'HEAD'])
    if (!mergeBase) {
      continue
    }
    const diff = git(['diff', '--name-only', '--no-renames', mergeBase, 'HEAD'])
    return { base, files: new Set((diff ?? '').split('\n').filter(Boolean)) }
  }
  return null
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
  return { status: result.status, timedOut, elapsedMs: Date.now() - started }
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
      if (step.status !== 0) {
        return { outcome: `${preparation.label} failed`, elapsedMs, forkTestsPassed }
      }
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
 * One isolated re-run of a file, reported as the tests that passed and failed inside it.
 *
 * Why per test rather than per file: the file's own allowlisted reds still fail when it runs alone,
 * so "the file exited non-zero" cannot tell a load flake from a real break once entries are named.
 * A missing report is not evidence of anything, so it reads as "every failure reproduced".
 */
function rerunIsolation(file, reportPath, timeoutMs) {
  const logFd = openSync(join(reportPath, '..', 'isolation.log'), 'a')
  try {
    const step = runStep(
      `isolation re-run ${file}`,
      'node',
      [
        RUN_VITEST,
        'run',
        '--config',
        'config/vitest.config.ts',
        '--reporter=json',
        `--outputFile.json=${reportPath}`,
        file
      ],
      logFd,
      timeoutMs,
      UNIT_LANE_ENV
    )
    if (step.timedOut || !existsSync(reportPath)) {
      return NO_RERUN
    }
    try {
      return reportForFile(JSON.parse(readFileSync(reportPath, 'utf8')), file)
    } catch {
      // Why not readJsonFile: that exits the process, losing the summary this verdict is for.
      return NO_RERUN
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
    console.log(`  UNEXPECTED: ${failure.file} › ${failure.test} — ${failure.detail}`)
  }
  if (result.unexpected.length > MAX_SUMMARY_LIST) {
    console.log(`  …and ${result.unexpected.length - MAX_SUMMARY_LIST} more unexpected failure(s)`)
  }
  for (const entry of result.flaky) {
    console.log(
      `  ${entry.inDiff ? 'FLAKY, but in this branch diff — not waived' : 'FLAKY, not ours'}: ${entry.file} › ${entry.test}`
    )
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
  if (unhandled.declaredCount !== null && unhandled.declaredCount > unhandled.headlines.length) {
    problems.push(
      `Vitest declared ${unhandled.declaredCount} unhandled error(s) but only ${unhandled.headlines.length} could be read; failing closed`
    )
  }

  // A failure outside the allowlist gets one isolated re-run. A failure that does not come back is
  // a load-order flake — a different claim from "this change broke it" — so it is waived unless the
  // file is in the diff. Judged per test: the file's allowlisted reds still fail when it runs alone.
  const diff = branchDiff()
  const flaky = []
  const blocking = []
  const unexpectedByFile = new Map()
  for (const failure of unexpected) {
    const list = unexpectedByFile.get(failure.file) ?? []
    list.push(failure)
    unexpectedByFile.set(failure.file, list)
  }
  let isolationIndex = 0
  for (const [file, failures] of unexpectedByFile) {
    isolationIndex += 1
    const rerun = rerunIsolation(
      file,
      join(dir, `isolation-${isolationIndex}.json`),
      options.timeoutMs
    )
    const reproduced = new Set(reproducedFailures(failures, rerun).map((failure) => failure.test))
    const inDiff = diff ? diff.files.has(file) : true
    for (const failure of failures) {
      if (reproduced.has(failure.test) || inDiff) {
        blocking.push(failure)
      } else {
        flaky.push({ file, test: failure.test, inDiff })
      }
    }
  }

  const exitCode = blocking.length === 0 && problems.length === 0 ? 0 : 1
  return {
    revision,
    clean: !options.allowDirty,
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
  const revision = git(['rev-parse', 'HEAD'])
  // Why the gitdir and not `<root>/.git`: in a linked worktree `.git` is a file, so the literal path
  // is not a directory and the gate could not record the verdict it just computed.
  const cacheDir = unitGateCacheDir(git(['rev-parse', '--absolute-git-dir']) ?? join(ROOT, '.git'))
  const cachePath = revision ? cachedVerdictPath(cacheDir, revision, allowlistHash) : null
  // A cached verdict is only reused for the gate's own no-argument run: a forwarded selector
  // describes a different suite, so it must not read or write the revision's verdict.
  const cacheable = options.cache && options.vitestArgs.length === 0 && cachePath !== null

  if (cacheable && existsSync(cachePath)) {
    const cached = readJsonFile(cachePath, 'cached verdict')
    // Why a dirty verdict is not reused: it says nothing about the revision, and reusing it would make
    // the gate's own advice ("re-run on a committed tree") impossible to follow.
    if (cached.clean === true) {
      console.log(
        'gate-unit: cached verdict for this revision and allowlist (pass --no-cache to re-run)'
      )
      reportResult(cached)
      process.exit(cached.exitCode)
    }
    console.log('gate-unit: ignoring the cached verdict — it was produced on a dirty tree')
  }

  const dir = mkdtempSync(join(tmpdir(), 'orca-gate-'))
  const result = evaluate(options, {
    dir,
    reportPath: join(dir, 'report.json'),
    logPath: join(dir, 'run.log')
  })

  // Why only a clean tree writes: a verdict from `--allow-dirty` is about a tree, not a revision, so
  // it must never become the verdict a PR is opened on.
  if (cacheable && result.clean === true) {
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(cachePath, `${JSON.stringify(result, null, 2)}\n`)
  }
  reportResult(result)
  process.exit(result.exitCode)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
}
