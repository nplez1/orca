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
import { createHash } from 'node:crypto'
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { UNIT_EXCLUDE, UNIT_INCLUDE } from '../config/scripts/ci-unit-files.mjs'
import { TOLERATED_UNHANDLED_ERROR, collectUnhandledErrors } from './check-unit-shard-verdict.mjs'

const ROOT = resolve(import.meta.dirname, '..')
/** Why this switch: the unit and PR workflows set it, and it is what makes `config/vitest.config.ts`
 *  apply upstream's `UNIT_EXCLUDE` instead of `defaultExclude`. */
const UNIT_LANE_ENV = { ORCA_BALANCE_UNIT_SHARDS: '1' }
/** `local/` is outside `UNIT_INCLUDE` by upstream's definition, so nothing else would run these. */
const FORK_TEST_INCLUDE = ['local/**/*.test.mjs']
const FORK_TEST_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_ALLOWLIST = join(ROOT, 'local', 'unit-known-red.json')
// Why the gitdir and not `<root>/.git`: in a linked worktree `.git` is a file, so the literal path
// is not a directory and the gate could not record the verdict it just computed.
const CACHE_DIR = join(git(['rev-parse', '--absolute-git-dir']) ?? join(ROOT, '.git'), 'orca-gate')
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

/** Entries are file-level (`*` or absent) unless they name a test. */
export function allowlistEntries(manifest) {
  const entries = Array.isArray(manifest.entries) ? manifest.entries : []
  return entries.map((entry) => {
    const file = String(entry.file).replaceAll('\\', '/')
    const test = entry.test === undefined || entry.test === '*' ? null : String(entry.test)
    return {
      file,
      test,
      class: String(entry.class ?? 'unclassified'),
      owner: String(entry.owner ?? 'unattributed'),
      flaky: entry.flaky === true,
      key: test === null ? `${file} › *` : `${file} › ${test}`
    }
  })
}

export function repoPath(name) {
  // Why both sides: Vitest reports forward-slash names even on Windows, where ROOT is backslashed.
  const root = ROOT.replaceAll('\\', '/')
  const normalised = String(name ?? '').replaceAll('\\', '/')
  return normalised.startsWith(root) ? normalised.slice(root.length).replace(/^\//, '') : normalised
}

function firstLine(message) {
  const line = String(message ?? '')
    .replace(/^Error:\s*/, '')
    .split('\n')[0]
    .trim()
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

/**
 * Vitest's JSON reporter is jest-shaped: one entry per file in `testResults`, one per case in
 * `assertionResults`. A file can fail without a failing assertion (collect/import error), so that
 * is recorded as a `(suite)` failure rather than being lost.
 */
export function collectCases(report) {
  const failures = []
  const passes = []
  for (const file of report.testResults ?? []) {
    const path = repoPath(file.name)
    let sawFailedCase = false
    for (const assertion of file.assertionResults ?? []) {
      const test = String(assertion.fullName || assertion.title || '(unnamed)')
      if (assertion.status === 'failed') {
        sawFailedCase = true
        failures.push({ file: path, test, detail: firstLine(assertion.failureMessages) })
      } else if (assertion.status === 'passed') {
        passes.push({ file: path, test })
      }
    }
    if (!sawFailedCase && file.status === 'failed') {
      failures.push({
        file: path,
        test: '(suite)',
        detail: firstLine(file.message) || 'the file failed without a failing case'
      })
    }
  }
  return { failures, passes }
}

export function judge(entries, failures, passes) {
  const known = []
  const unexpected = []
  for (const failure of failures) {
    const entry = entries.find(
      (candidate) =>
        candidate.file === failure.file &&
        (candidate.test === null || candidate.test === failure.test)
    )
    if (entry) {
      known.push({ failure, entry })
    } else {
      unexpected.push(failure)
    }
  }
  // Why the failure set is consulted: a file-level entry matches one failing case while other
  // cases in the same file pass, which must not read as "this entry is stale".
  const matched = new Set(known.map((item) => item.entry.key))
  const stale = entries.filter(
    (entry) =>
      !matched.has(entry.key) &&
      passes.some(
        (pass) => pass.file === entry.file && (entry.test === null || entry.test === pass.test)
      )
  )
  // Why not "the file did not fail": with a named entry, a renamed or deleted case is unmatched and
  // not stale while its file still reds elsewhere — the entry has gone dead, and nothing else says so.
  const staleKeys = new Set(stale.map((entry) => entry.key))
  const unseen = entries.filter((entry) => !matched.has(entry.key) && !staleKeys.has(entry.key))
  return { known, unexpected, stale, unseen }
}

/**
 * An unhandled error is a claim about the run, not about one test, so it is matched by headline and
 * collapsed: one suite can raise the same rejection 28 times, and 28 identical lines is noise.
 */
export function judgeUnhandled(headlines, entries) {
  const declared = Array.isArray(entries) ? entries : []
  const counts = new Map()
  for (const headline of headlines) {
    counts.set(headline, (counts.get(headline) ?? 0) + 1)
  }
  const known = []
  const blocking = []
  for (const [headline, count] of counts) {
    const entry = declared.find((candidate) => String(candidate.headline) === headline)
    if (entry) {
      known.push({ ...entry, headline, count })
    } else {
      blocking.push({ headline, count })
    }
  }
  return { known, blocking }
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

/** An entry for a file the gate never runs can never match, which is the same rot as a stale one. */
export function quarantinedEntryProblems(entries, quarantined) {
  const set = quarantined instanceof Set ? quarantined : new Set(quarantined)
  return entries
    .filter((entry) => set.has(entry.file))
    .map((entry) => `allowlist entry for a file the gate does not run (UNIT_EXCLUDE): ${entry.key}`)
}

/** Files the report collected although `UNIT_EXCLUDE` drops them: the exclusion did not apply. */
export function collectedQuarantinedFiles(report, quarantined) {
  const set = quarantined instanceof Set ? quarantined : new Set(quarantined)
  return (report?.testResults ?? [])
    .map((file) => repoPath(file.name))
    .filter((file) => set.has(file))
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
    for (const [label, program, args] of [
      ['build:packages', 'pnpm', ['run', 'build:packages']],
      [
        'ensure native runtime',
        'node',
        [join(ROOT, 'config', 'scripts', 'ensure-native-runtime.mjs'), '--runtime=node']
      ]
    ]) {
      const step = runStep(label, program, args, logFd, timeoutMs)
      elapsedMs += step.elapsedMs
      if (step.timedOut) {
        return { outcome: 'timed-out', elapsedMs, forkTestsPassed }
      }
      if (step.status !== 0) {
        return { outcome: `${label} failed`, elapsedMs, forkTestsPassed }
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
 * One isolated re-run of a file, reported as the tests that failed inside it.
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
      return { complete: false, failures: new Set() }
    }
    const cases = collectCases(readJsonFile(reportPath, 'isolation report'))
    return { complete: true, failures: new Set(cases.failures.map((failure) => failure.test)) }
  } finally {
    closeSyncSafe(logFd)
  }
}

function formatSummary(result) {
  const counts = result.counts
  const unhandledBlocking = result.unhandled?.blocking?.length ?? 0
  const quarantined = result.quarantined?.count ?? 0
  const forkTests = result.forkTests ?? { files: 0, passed: false }
  const parts = [
    `${counts.passed} passed`,
    `${counts.failed} failed (${counts.known} allowlisted, ${result.unexpected.length} unexpected)`,
    `${result.flaky.length} flaky re-run passed`,
    `${unhandledBlocking} unhandled error headline(s)`,
    `${quarantined} upstream-quarantined file(s) not run`,
    `${forkTests.files} fork-local test file(s) ${forkTests.passed ? 'passed' : 'FAILED'}`
  ]
  return `Unit gate @${result.revision.slice(0, 10)} (${result.clean ? 'clean' : 'dirty'}): ${result.exitCode === 0 ? 'PASS' : 'FAIL'} — ${parts.join('; ')}; ${(result.elapsedMs / 1000).toFixed(0)} s`
}

function reportResult(result) {
  console.log(formatSummary(result))
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
    unseen = fullRun ? judged.unseen : []
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
    for (const failure of failures) {
      const reproduced = !rerun.complete || rerun.failures.has(failure.test)
      const inDiff = diff ? diff.files.has(file) : true
      if (reproduced || inDiff) {
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
  const allowlistHash = createHash('sha256')
    .update(readFileSync(options.allowlist))
    .digest('hex')
    .slice(0, 12)
  const revision = git(['rev-parse', 'HEAD'])
  const cachePath = revision
    ? join(CACHE_DIR, `${revision.slice(0, 12)}-${allowlistHash}.json`)
    : null
  // A cached verdict is only reused for the gate's own no-argument run: a forwarded selector
  // describes a different suite, so it must not read or write the revision's verdict.
  const cacheable = options.cache && options.vitestArgs.length === 0 && cachePath !== null

  if (cacheable && existsSync(cachePath)) {
    const cached = readJsonFile(cachePath, 'cached verdict')
    console.log(
      'gate-unit: cached verdict for this revision and allowlist (pass --no-cache to re-run)'
    )
    reportResult(cached)
    process.exit(cached.exitCode)
  }

  const dir = mkdtempSync(join(tmpdir(), 'orca-gate-'))
  const result = evaluate(options, {
    dir,
    reportPath: join(dir, 'report.json'),
    logPath: join(dir, 'run.log')
  })

  if (cacheable) {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(cachePath, `${JSON.stringify(result, null, 2)}\n`)
  }
  reportResult(result)
  process.exit(result.exitCode)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
}
