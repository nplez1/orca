#!/usr/bin/env node
/**
 * Unit-shard verdict for this fork.
 *
 * Vitest 4 and 5 fail a run whose tests all passed when a worker's `onUserConsoleLog` RPC is still
 * in flight as that worker closes (vitest-dev/vitest#11153). It reads as a shard failure while
 * every test passes, it names whichever worker was closing rather than the file that logged late,
 * and at roughly half of this fork's shard-8 runs it is frequent enough to make CI a coin flip.
 *
 * The skip is exact. A test failure, any other unhandled error, an unreadable report, a shard that
 * ran no tests, and a failed shard with no tolerated race all still fail — so a crashed, timed-out
 * or genuinely red shard cannot pass as green.
 *
 * A report is not evidence of coverage on its own: a worker that dies takes its file out of the
 * report, and the report over whatever ran still reads green. So `--assignment` names the manifest
 * `TimingSequencer` wrote from the same plan it handed Vitest, and the verdict fails on any assigned
 * file the report does not list, and on any file the report lists that the shard was not assigned.
 * A tolerated worker crash also cannot explain a failed shard by itself: a crash can lose tests
 * inside a file that is still listed, which the file set cannot see.
 *
 * Upstream's own runs never call this: `.github/workflows/unit-tests.yml` guards it on
 * `github.repository` and leaves Vitest's exit code in charge there.
 *
 * Known reds are the second tolerance, and the reason the nightly stopped mailing an alarm for a
 * failure the repo had already triaged: a failing test that matches an entry in
 * `local/nightly-linux-known-red.json` is reported as tolerated rather than failing the job. Every
 * red that matches nothing still fails, and it fails by name — so the one alarm left is a failure
 * nobody has classified yet.
 *
 * What it cannot see: a describe-level hook failure that Vitest attributes to a suite rather than to
 * the file's `message`. `numFailedTestSuites` counts failing describes as well as failing files (2 for
 * one failing file, measured), so it cannot be used to catch that without failing every night.
 *
 * Usage: node local/check-unit-shard-verdict.mjs REPORT.json SHARD.log OUTCOME
 *          [--known-red PATH] [--assignment PATH]
 */
import { existsSync, readFileSync } from 'node:fs'
import { entryFileMatches, entryMatchesFailure } from './lib/linux-parity.mjs'
import { reportFileSetProblem } from './unit-gate-judgement.mjs'

// Why not the shared stripAnsiEscapeSequences: that helper is TypeScript and CI runs this script
// under plain node. The reporter only colours with SGR codes, so `ESC[…m` is the whole alphabet.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
/** The one headline this fork tolerates, verbatim from Vitest's teardown path. */
export const TOLERATED_UNHANDLED_ERROR =
  'EnvironmentTeardownError: [vitest-worker]: Closing rpc while "onUserConsoleLog" was pending'
// Why `\W` on both sides: Vitest frames these headers in box-drawing rules (U+23AF at this
// version), and pinning the glyph would make the verdict fail closed on its next cosmetic change.
const UNHANDLED_HEADER = /^\W*Unhandled Errors\W*$/
// Why `Unhandled Error` too: Vitest frames a pool/worker failure with that heading, not
// `Unhandled Rejection`, and missing it made the declared count unreadable (failing closed).
const ERROR_SEPARATOR =
  /^\W*Unhandled Rejection\W*$|^\W*Uncaught Exception\W*$|^\W*Unhandled Error\W*$/
const FAILING_TEST_LIMIT = 5
/** The manifest this runner's known reds live in; the Mac allowlist names a different environment. */
export const DEFAULT_KNOWN_RED = 'local/nightly-linux-known-red.json'

/**
 * An unhandled error is a claim about the run, not about a test, and its headline can carry a
 * machine-specific path (a pnpm store location, a dev-server URL). So a manifest entry may give a
 * `match` regex source instead of an exact `headline`; either form tolerates the headline.
 */
function entryMatcher(entry) {
  return typeof entry?.match === 'string'
    ? new RegExp(entry.match)
    : new RegExp(`^${String(entry?.headline ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
}

export function unhandledMatchers(manifest) {
  const declared = Array.isArray(manifest) ? manifest : []
  return declared.map(entryMatcher)
}

export function toleratedUnhandled(headline, matchers = []) {
  if (headline === TOLERATED_UNHANDLED_ERROR) {
    return true
  }
  return matchers.some((matcher) => matcher.test(headline))
}

/**
 * Whether a tolerated headline can account for a non-zero exit, and the entry that tolerated it.
 *
 * Why an entry may say it cannot: a worker that died can lose tests inside a file the report still
 * lists, so a crash explains nothing on its own — it is only tolerable beside an absorbed red that
 * already explains the exit. The teardown race is different: it is raised after the file's tests
 * finished, so it accounts for the exit and nothing else.
 */
export function unhandledExplanation(headline, entries = []) {
  if (headline === TOLERATED_UNHANDLED_ERROR) {
    return { tolerated: true, explainsFailure: true, entry: null }
  }
  const entry = (Array.isArray(entries) ? entries : []).find((candidate) =>
    entryMatcher(candidate).test(headline)
  )
  return {
    tolerated: entry !== undefined,
    explainsFailure: entry?.explainsFailure !== false,
    entry: entry ?? null
  }
}

/**
 * Files the report names that this shard was never assigned, and the pairing both directions need:
 * a report names `/home/runner/work/orca/orca/src/a.test.ts` while the assignment says
 * `src/a.test.ts`, and neither side knows where the other ran. The longest shared `/`-bounded suffix
 * is the match — the same rule `entryFileMatches` applies to a red, and why a sibling directory
 * (`src/other/a.test.ts`) never pairs with `src/a.test.ts`.
 */
export function matchAssignedFiles(report, assignedFiles) {
  const assigned = new Set(assignedFiles)
  const matched = new Map()
  const unassigned = new Set()
  for (const file of report?.testResults ?? []) {
    const path = String(file?.name ?? '').replaceAll('\\', '/')
    const suffixes = [path]
    for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) {
      suffixes.push(path.slice(at + 1))
    }
    // Why the `/`: a suffix is only a path match at a separator, so `…/src/a.test.ts` never pairs
    // with an assigned `a.test.ts`. Every `UNIT_INCLUDE` glob is two directories deep, so an
    // assigned file always has one; the whole path is accepted as-is for a report that is already
    // repo-relative.
    const match =
      suffixes.find(
        (suffix, depth) => (depth === 0 || suffix.includes('/')) && assigned.has(suffix)
      ) ?? null
    matched.set(path, match)
    if (match === null) {
      unassigned.add(path)
    }
  }
  return { matched, unassigned: [...unassigned].sort() }
}

/**
 * The files a shard was assigned, from the manifest `TimingSequencer` writes. Returns `{ files }` or
 * `{ problem }`: every way of not knowing the assignment is a failure, never a skipped check.
 */
export function readShardAssignment(text, { runId = null, runAttempt = null } = {}) {
  let assignment
  try {
    assignment = JSON.parse(String(text))
  } catch {
    return {
      problem:
        'the shard assignment is unreadable, so nothing proves which files this shard should have run'
    }
  }
  const shards = assignment?.shards
  if (!Array.isArray(shards) || shards.length === 0) {
    return { problem: 'the shard assignment holds no shards, so it proves nothing about this one' }
  }
  const selected = Number(assignment?.selectedShard)
  if (!Number.isInteger(selected) || selected < 1 || selected > shards.length) {
    return {
      problem: `the shard assignment selects shard ${assignment?.selectedShard}, which is not one of its ${shards.length} shard(s)`
    }
  }
  // Why: the default runner can reuse a workspace, so a manifest left by an earlier run or attempt
  // would otherwise be judged against this run's report.
  for (const [key, current] of [
    ['runId', runId],
    ['runAttempt', runAttempt]
  ]) {
    const recorded = assignment?.[key]
    if (recorded != null && current != null && String(recorded) !== String(current)) {
      return {
        problem: `the shard assignment is from ${key} ${recorded}, not this one (${current}); a stale manifest does not describe this run`
      }
    }
  }
  const files = shards[selected - 1]?.files
  if (!Array.isArray(files) || files.some((file) => typeof file !== 'string' || file === '')) {
    return { problem: `the shard assignment for shard ${selected} has no usable file list` }
  }
  return { files }
}

export function declaredUnhandledEntries(manifest) {
  return Array.isArray(manifest?.unhandledErrors) ? manifest.unhandledErrors : []
}

/** One matcher for both this shard verdict and the cross-shard checker, so the two always agree. */
function matchingEntry(knownRed, file, test) {
  return knownRed.find((entry) => entryMatchesFailure(entry, { file, test }))
}

/** Vitest prints its own count; a mismatch means the log shape moved, so the verdict fails closed. */
export function collectUnhandledErrors(logText) {
  const lines = String(logText).replace(ANSI, '').split('\n')
  const headlines = []
  let declaredCount = null
  let sectionPresent = false

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (UNHANDLED_HEADER.test(line)) {
      sectionPresent = true
    }
    const counted = /Vitest caught (\d+) unhandled error/.exec(line)
    if (counted) {
      declaredCount = Number(counted[1])
    }
    if (!ERROR_SEPARATOR.test(line)) {
      continue
    }
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next].trim()
      if (candidate.length > 0) {
        headlines.push(candidate)
        break
      }
    }
  }

  return { sectionPresent, declaredCount, headlines }
}

function failingTestNames(report) {
  const names = []
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status === 'failed') {
        names.push({ file: file.name, test: assertion.fullName || assertion.title })
      }
    }
  }
  return names
}

// Why: a file whose import or `beforeAll` threw reports every test skipped, so no `failing:` line
// names it and the shard reads as red with no culprit.
function failedFilesWithoutFailingTest(report) {
  const failures = []
  for (const file of report.testResults ?? []) {
    if (file.status !== 'failed') {
      continue
    }
    // Why a message counts even when a row failed too: an afterAll or teardown error is not the
    // failure the entry accounts for, so absorbing the row must not absorb this red beside it.
    const hasFailingTest = (file.assertionResults ?? []).some(
      (assertion) => assertion.status === 'failed'
    )
    if (file.message || !hasFailingTest) {
      failures.push({ file: file.name, detail: file.message || '' })
    }
  }
  return failures
}

/**
 * The verdict's inputs are the JSON report (what the tests did), the captured run log (which
 * unhandled errors were raised) and the test step's own outcome (so a failure the report cannot
 * explain still fails).
 */
export function decideUnitShardVerdict({
  reportText,
  logText,
  outcome,
  knownRed = [],
  unhandledErrors = [],
  assignedFiles
}) {
  const unhandledMatcherList = unhandledMatchers(unhandledErrors)
  const problems = []
  const tolerated = []
  const absorbed = []
  const absorbedEntries = new Set()
  const prunable = []
  let report = null

  try {
    report = JSON.parse(String(reportText))
  } catch {
    problems.push(
      'the Vitest JSON report is missing or unreadable, so nothing proves the shard ran'
    )
  }

  if (report) {
    const totalTests = Number(report.numTotalTests) || 0
    const declaredFailedTests = Number(report.numFailedTests) || 0
    const failingTests = failingTestNames(report)
    if (totalTests === 0) {
      problems.push('the report holds no tests, so the shard cannot be judged green')
    }
    // Why the assignment is the yardstick: a worker that died takes its file out of the report, and
    // a report over whatever ran still reads green. Only the plan Vitest was given says what ran.
    if (Array.isArray(assignedFiles)) {
      if (assignedFiles.length === 0) {
        problems.push(
          'the shard assignment gives this shard no files, so nothing proves what it should have run'
        )
      } else {
        const { matched, unassigned } = matchAssignedFiles(report, assignedFiles)
        // Why the pairing happens here rather than inside the shared check: `reportFileSetProblem`
        // resolves a report path against the judging process's own checkout, and this verdict has to
        // judge a report produced somewhere else too — a downloaded artifact names
        // `/home/runner/work/orca/orca/...`, which is no path on the machine reading it. Pairing
        // first keeps the gate's wording and costs it nothing.
        const paired = [...matched]
          .filter(([, file]) => file !== null)
          .map(([, file]) => ({ name: file }))
        const missing = reportFileSetProblem({ testResults: paired }, assignedFiles)
        if (missing) {
          problems.push(missing)
        }
        // Why the other direction: a manifest from another run, shard or revision can be a subset of
        // this one, and then a missing-file check alone reads it as the whole assignment.
        if (unassigned.length > 0) {
          const more = unassigned.length > 12 ? ` …and ${unassigned.length - 12} more` : ''
          problems.push(
            `the report names ${unassigned.length} file(s) this shard was not assigned, so the assignment does not describe this run: ${unassigned.slice(0, 12).join(', ')}${more}`
          )
        }
      }
    }
    // Why fail closed on a mismatch: a row the report counts but does not list is a red whose name
    // nobody sees, and a listed row the report does not count means the shape moved under us.
    if (declaredFailedTests !== failingTests.length) {
      problems.push(
        `the report declares ${declaredFailedTests} failing test(s) but lists ${failingTests.length}; failing closed`
      )
    }
    const unexpected = []
    for (const { file, test } of failingTests) {
      const entry = matchingEntry(knownRed, file, test)
      if (entry) {
        absorbed.push(`${file} › ${test} [${entry.class}]`)
        absorbedEntries.add(entry)
      } else {
        unexpected.push(`${file} › ${test}`)
      }
    }
    for (const name of unexpected.slice(0, FAILING_TEST_LIMIT)) {
      problems.push(`failing: ${name}`)
    }
    if (unexpected.length > FAILING_TEST_LIMIT) {
      problems.push(`and ${unexpected.length - FAILING_TEST_LIMIT} more unexpected failure(s)`)
    }
    const fileLevelFailures = failedFilesWithoutFailingTest(report)
    for (const { file, detail } of fileLevelFailures) {
      const entry = matchingEntry(knownRed, file, null)
      if (entry) {
        absorbed.push(`${file} [${entry.class}]`)
        absorbedEntries.add(entry)
      } else {
        const why = detail ? ` — ${detail.split('\n')[0].slice(0, 160)}` : ''
        problems.push(`failing file (no test accounts for it): ${file}${why}`)
      }
    }
    for (const entry of knownRed) {
      // Why a passed row is required: a file that crashed before this test ran, or a test that was
      // renamed or skipped, is not evidence the entry can go. Only "it ran and passed" is.
      const passed = (report.testResults ?? []).some(
        (file) =>
          entryFileMatches(entry, file.name) &&
          (file.assertionResults ?? []).some(
            (assertion) =>
              assertion.status === 'passed' &&
              entryMatchesFailure(entry, {
                file: file.name,
                test: assertion.fullName || assertion.title
              })
          )
      )
      if (passed && !absorbedEntries.has(entry)) {
        prunable.push(`${entry.file}${entry.test ? ` › ${entry.test}` : ''}`)
      }
    }
  }

  const unhandled = collectUnhandledErrors(logText)
  if (unhandled.declaredCount !== null && unhandled.declaredCount !== unhandled.headlines.length) {
    problems.push(
      `Vitest reported ${unhandled.declaredCount} unhandled error(s) but ${unhandled.headlines.length} could be read; failing closed`
    )
  }
  for (const headline of unhandled.headlines) {
    if (toleratedUnhandled(headline, unhandledMatcherList)) {
      tolerated.push(headline)
    } else {
      problems.push(`unhandled error: ${headline}`)
    }
  }

  if (outcome !== 'success' && outcome !== 'failure') {
    problems.push(`unknown test-step outcome "${outcome}"`)
  } else if (outcome === 'failure' && problems.length === 0 && absorbed.length === 0) {
    // Why any crash fails the shard, even beside another tolerated headline: a worker that died can
    // lose tests inside a file the report still lists, which the file set cannot see. A bystander
    // teardown error does not rule that out, so only an absorbed red may account for the exit.
    const unexplained = tolerated.filter(
      (headline) => !unhandledExplanation(headline, unhandledErrors).explainsFailure
    )
    if (unexplained.length > 0) {
      problems.push(
        `the shard failed and nothing absorbed accounts for its worker crash, which can lose tests the report still lists: ${unexplained.join('; ')}`
      )
    } else if (tolerated.length === 0) {
      problems.push('the shard failed without the tolerated Vitest teardown race')
    }
  }

  return { ok: problems.length === 0, tolerated, absorbed, prunable, problems }
}

function readOrReport(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    console.error(`::error::cannot read ${path}: ${error.message}`)
    return null
  }
}

function parseArgs(argv) {
  const positional = []
  let knownRedPath = null
  let assignmentPath = null
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--known-red' || argv[index] === '--assignment') {
      // Why a missing value is a usage error rather than "no flag": the caller asked for a manifest
      // and silently got none, which is the difference between judging against it and not.
      if (argv[index + 1] === undefined) {
        console.error(`usage: ${argv[index]} needs a path`)
        process.exit(2)
      }
      if (argv[index] === '--known-red') {
        knownRedPath = argv[index + 1]
      } else {
        assignmentPath = argv[index + 1]
      }
      index += 1
    } else {
      positional.push(argv[index])
    }
  }
  return { positional, knownRedPath, assignmentPath }
}

/**
 * Why the path is optional and absent is not a failure: this script also runs on this Mac, where the
 * Linux manifest describes a different machine. An unreadable manifest the caller named is a failure.
 */
function loadKnownRed(knownRedPath) {
  const path = knownRedPath ?? (process.platform === 'linux' ? DEFAULT_KNOWN_RED : null)
  if (path === null || !existsSync(path)) {
    if (knownRedPath !== null) {
      console.log(`::error::unit shard: cannot read the known-red manifest ${path}`)
      process.exit(1)
    }
    return { entries: [], unhandledErrors: [] }
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(parsed.entries)) {
      throw new Error('no entries array')
    }
    // Why: an entry that says `"explainsFailure": "no"` would read as `true` and silently restore
    // the crash hole this field exists to close.
    const unhandled = declaredUnhandledEntries(parsed)
    if (
      unhandled.some(
        (entry) =>
          entry?.explainsFailure !== undefined && typeof entry.explainsFailure !== 'boolean'
      )
    ) {
      throw new Error('an unhandledErrors entry has a non-boolean explainsFailure')
    }
    return parsed
  } catch (error) {
    console.log(`::error::unit shard: cannot read the known-red manifest ${path}: ${error.message}`)
    process.exit(1)
  }
}

/**
 * Why an absent flag skips the check but a named path never does: this script also runs on this Mac
 * and in its own unit tests, where no shard assignment exists. A caller that names an assignment is
 * asking for the file set to be judged, so anything short of a usable one fails closed.
 */
function loadAssignment(assignmentPath) {
  let text
  try {
    text = readFileSync(assignmentPath, 'utf8')
  } catch (error) {
    console.log(
      `::error::unit shard: cannot read the shard assignment ${assignmentPath}: ${error.message}`
    )
    process.exit(1)
  }
  const { files, problem } = readShardAssignment(text, {
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null
  })
  if (problem) {
    console.log(`::error::unit shard: ${problem} (${assignmentPath})`)
    process.exit(1)
  }
  return files
}

function main() {
  const { positional, knownRedPath, assignmentPath } = parseArgs(process.argv.slice(2))
  const [reportPath, logPath, outcome] = positional
  if (!reportPath || !logPath || outcome === undefined) {
    console.error(
      'usage: node local/check-unit-shard-verdict.mjs REPORT.json SHARD.log OUTCOME [--known-red PATH] [--assignment PATH]'
    )
    process.exit(2)
  }
  const reportText = readOrReport(reportPath)
  const logText = readOrReport(logPath)
  if (reportText === null || logText === null) {
    process.exit(1)
  }

  const manifest = loadKnownRed(knownRedPath)
  const unhandledErrors = declaredUnhandledEntries(manifest)
  const verdict = decideUnitShardVerdict({
    reportText,
    logText,
    outcome,
    knownRed: Array.isArray(manifest) ? manifest : manifest.entries,
    unhandledErrors,
    assignedFiles: assignmentPath === null ? undefined : loadAssignment(assignmentPath)
  })
  for (const headline of verdict.tolerated) {
    const { entry } = unhandledExplanation(headline, unhandledErrors)
    // Why the class rather than the teardown-race text for every headline: a pool crash is not
    // vitest-dev/vitest#11153, and naming it as such is how a crash stopped being visible.
    console.log(
      entry === null
        ? `::warning::unit shard tolerated the Vitest worker teardown race (vitest-dev/vitest#11153): ${headline}`
        : `::warning::unit shard tolerated a listed run-level error [${entry.class ?? 'unclassified'}]: ${headline}`
    )
  }
  for (const entry of verdict.absorbed) {
    console.log(`::warning::unit shard tolerated a known Linux red, already triaged: ${entry}`)
  }
  for (const entry of verdict.prunable) {
    console.log(
      `::notice::unit shard: ${entry} did not fail here, so its known-red entry may be prunable`
    )
  }
  for (const problem of verdict.problems) {
    console.log(`::error::unit shard: ${problem}`)
  }
  if (!verdict.ok) {
    process.exit(1)
  }
  const absorbed = verdict.absorbed.length
  console.log(
    absorbed === 0
      ? '::notice::unit shard verdict: every test passed, no unexplained error'
      : `::notice::unit shard verdict: every test passed apart from ${absorbed} known red(s), no unexplained error`
  )
}

if (process.argv[1] && process.argv[1].endsWith('check-unit-shard-verdict.mjs')) {
  main()
}
