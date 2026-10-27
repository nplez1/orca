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
 * Upstream's own runs never call this: `.github/workflows/unit-tests.yml` guards it on
 * `github.repository` and leaves Vitest's exit code in charge there.
 *
 * Known reds are the second tolerance, and the reason the nightly stopped mailing an alarm for a
 * failure the repo had already triaged: a failing test that matches an entry in
 * `local/nightly-linux-known-red.json` is reported as tolerated rather than failing the job. Every
 * red that matches nothing still fails, and it fails by name — so the one alarm left is a failure
 * nobody has classified yet.
 *
 * Usage: node local/check-unit-shard-verdict.mjs REPORT.json SHARD.log OUTCOME [--known-red PATH]
 */
import { existsSync, readFileSync } from 'node:fs'
import { entryFileMatches, entryMatchesFailure } from './lib/linux-parity.mjs'

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
  return (report.testResults ?? [])
    .filter(
      (file) =>
        file.status === 'failed' &&
        !(file.assertionResults ?? []).some((assertion) => assertion.status === 'failed')
    )
    .map((file) => file.name)
}

/**
 * The verdict's inputs are the JSON report (what the tests did), the captured run log (which
 * unhandled errors were raised) and the test step's own outcome (so a failure the report cannot
 * explain still fails).
 */
export function decideUnitShardVerdict({ reportText, logText, outcome, knownRed = [] }) {
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
    for (const file of fileLevelFailures) {
      const entry = matchingEntry(knownRed, file, null)
      if (entry) {
        absorbed.push(`${file} [${entry.class}]`)
        absorbedEntries.add(entry)
      } else {
        problems.push(`failing file (no test ran to failure): ${file}`)
      }
    }
    for (const entry of knownRed) {
      const present = (report.testResults ?? []).some((file) => entryFileMatches(entry, file.name))
      if (present && !absorbedEntries.has(entry)) {
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
    if (headline === TOLERATED_UNHANDLED_ERROR) {
      tolerated.push(headline)
    } else {
      problems.push(`unhandled error: ${headline}`)
    }
  }

  if (outcome !== 'success' && outcome !== 'failure') {
    problems.push(`unknown test-step outcome "${outcome}"`)
  } else if (
    outcome === 'failure' &&
    problems.length === 0 &&
    tolerated.length === 0 &&
    absorbed.length === 0
  ) {
    problems.push('the shard failed without the tolerated Vitest teardown race')
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
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--known-red') {
      knownRedPath = argv[index + 1] ?? null
      index += 1
    } else {
      positional.push(argv[index])
    }
  }
  return { positional, knownRedPath }
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
    return []
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(parsed.entries)) {
      throw new Error('no entries array')
    }
    return parsed.entries
  } catch (error) {
    console.log(`::error::unit shard: cannot read the known-red manifest ${path}: ${error.message}`)
    process.exit(1)
  }
}

function main() {
  const { positional, knownRedPath } = parseArgs(process.argv.slice(2))
  const [reportPath, logPath, outcome] = positional
  if (!reportPath || !logPath || outcome === undefined) {
    console.error(
      'usage: node local/check-unit-shard-verdict.mjs REPORT.json SHARD.log OUTCOME [--known-red PATH]'
    )
    process.exit(2)
  }
  const reportText = readOrReport(reportPath)
  const logText = readOrReport(logPath)
  if (reportText === null || logText === null) {
    process.exit(1)
  }

  const knownRed = loadKnownRed(knownRedPath)
  const verdict = decideUnitShardVerdict({ reportText, logText, outcome, knownRed })
  for (const headline of verdict.tolerated) {
    console.log(
      `::warning::unit shard tolerated the Vitest worker teardown race (vitest-dev/vitest#11153): ${headline}`
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
