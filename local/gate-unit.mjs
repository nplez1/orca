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
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TOLERATED_UNHANDLED_ERROR, collectUnhandledErrors } from './check-unit-shard-verdict.mjs'

const ROOT = resolve(import.meta.dirname, '..')
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
function allowlistEntries(manifest) {
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
  const normalised = String(name ?? '').replaceAll('\\', '/')
  return normalised.startsWith(ROOT) ? relative(ROOT, normalised).replaceAll('\\', '/') : normalised
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
  const failingFiles = new Set(failures.map((failure) => failure.file))
  const unseen = entries.filter((entry) => !failingFiles.has(entry.file))
  return { known, unexpected, stale, unseen }
}

/** An unhandled error is a claim about the run, not about one test, so it is matched by headline. */
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

function runStep(label, program, args, logFd, timeoutMs) {
  process.stderr.write(`gate-unit: ${label}\n`)
  const started = Date.now()
  const result = spawnSync(program, args, {
    cwd: ROOT,
    stdio: ['ignore', logFd, logFd],
    timeout: timeoutMs,
    killSignal: 'SIGKILL'
  })
  const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGKILL'
  return { status: result.status, timedOut, elapsedMs: Date.now() - started }
}

function runSuite({ reportPath, logPath, timeoutMs, vitestArgs }) {
  const logFd = openSync(logPath, 'w')
  let elapsedMs = 0
  try {
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
        return { outcome: 'timed-out', elapsedMs }
      }
      if (step.status !== 0) {
        return { outcome: `${label} failed`, elapsedMs }
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
      timeoutMs
    )
    elapsedMs += suite.elapsedMs
    if (suite.timedOut) {
      return { outcome: 'timed-out', elapsedMs }
    }
    return { outcome: 'complete', status: suite.status, elapsedMs }
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

function rerunIsolation(file, dir, timeoutMs) {
  const logFd = openSync(join(dir, 'isolation.log'), 'a')
  try {
    const step = runStep(
      `isolation re-run ${file}`,
      'node',
      [RUN_VITEST, 'run', '--config', 'config/vitest.config.ts', '--reporter=dot', file],
      logFd,
      timeoutMs
    )
    return step.status === 0 && !step.timedOut
  } finally {
    closeSyncSafe(logFd)
  }
}

function formatSummary(result) {
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
  for (const file of result.flaky) {
    console.log(
      `  ${file.inDiff ? 'FLAKY, but in this branch diff — not waived' : 'FLAKY, not ours'}: ${file.file}`
    )
  }
  for (const entry of result.stale) {
    console.log(`  stale entry (passed in this run) — prune ${entry.key}`)
  }
  for (const entry of result.unseen) {
    console.log(
      `  unseen entry (did not fail in this run) — prune if the file no longer reds: ${entry.key}`
    )
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
  const entries = allowlistEntries(manifest)
  const run = runSuite({
    reportPath,
    logPath,
    timeoutMs: options.timeoutMs,
    vitestArgs: options.vitestArgs
  })

  const problems = []
  if (run.outcome !== 'complete') {
    problems.push(`the suite did not run to completion: ${run.outcome}`)
  }
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
    unseen = judged.unseen
    // Why not `numFailedTests`: it counts cases only, so a file that failed to collect would be
    // missing from it while it is very much a failure of this run.
    counts.failed = cases.failures.length
    counts.known = known.length
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

  // A failure outside the allowlist gets one isolated re-run. A pass there is a load-order flake —
  // a different claim from "this change broke it" — so it is waived unless the file is in the diff.
  const diff = branchDiff()
  const flaky = []
  const stillFailing = new Set()
  for (const file of new Set(unexpected.map((failure) => failure.file))) {
    if (rerunIsolation(file, dir, options.timeoutMs)) {
      flaky.push({ file, inDiff: diff ? diff.files.has(file) : true })
    } else {
      stillFailing.add(file)
    }
  }
  const blocking = unexpected.filter(
    (failure) =>
      stillFailing.has(failure.file) ||
      flaky.some((entry) => entry.file === failure.file && entry.inDiff)
  )

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
