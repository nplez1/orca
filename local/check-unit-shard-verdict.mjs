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
 * Usage: node local/check-unit-shard-verdict.mjs REPORT.json SHARD.log OUTCOME
 */
import { readFileSync } from 'node:fs'

// Why not the shared stripAnsiEscapeSequences: that helper is TypeScript and CI runs this script
// under plain node. The reporter only colours with SGR codes, so `ESC[…m` is the whole alphabet.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
/** The one headline this fork tolerates, verbatim from Vitest's teardown path. */
export const TOLERATED_UNHANDLED_ERROR =
  'EnvironmentTeardownError: [vitest-worker]: Closing rpc while "onUserConsoleLog" was pending'
// Why `\W` on both sides: Vitest frames these headers in box-drawing rules (U+23AF at this
// version), and pinning the glyph would make the verdict fail closed on its next cosmetic change.
const UNHANDLED_HEADER = /^\W*Unhandled Errors\W*$/
const ERROR_SEPARATOR = /^\W*Unhandled Rejection\W*$|^\W*Uncaught Exception\W*$/
const FAILING_TEST_LIMIT = 5

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
        names.push(`${file.name} › ${assertion.fullName || assertion.title}`)
      }
    }
  }
  return names
}

/**
 * The verdict's inputs are the JSON report (what the tests did), the captured run log (which
 * unhandled errors were raised) and the test step's own outcome (so a failure the report cannot
 * explain still fails).
 */
export function decideUnitShardVerdict({ reportText, logText, outcome }) {
  const problems = []
  const tolerated = []
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
    const failedTests = Number(report.numFailedTests) || 0
    const failedSuites = Number(report.numFailedTestSuites) || 0
    if (totalTests === 0) {
      problems.push('the report holds no tests, so the shard cannot be judged green')
    }
    if (failedSuites > 0) {
      problems.push(`${failedSuites} test file(s) failed`)
    }
    if (failedTests > 0) {
      problems.push(`${failedTests} test(s) failed`)
      for (const name of failingTestNames(report).slice(0, FAILING_TEST_LIMIT)) {
        problems.push(`failing: ${name}`)
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
  } else if (outcome === 'failure' && problems.length === 0 && tolerated.length === 0) {
    problems.push('the shard failed without the tolerated Vitest teardown race')
  }

  return { ok: problems.length === 0, tolerated, problems }
}

function readOrReport(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    console.error(`::error::cannot read ${path}: ${error.message}`)
    return null
  }
}

function main() {
  const [reportPath, logPath, outcome] = process.argv.slice(2)
  if (!reportPath || !logPath || outcome === undefined) {
    console.error('usage: node local/check-unit-shard-verdict.mjs REPORT.json SHARD.log OUTCOME')
    process.exit(2)
  }
  const reportText = readOrReport(reportPath)
  const logText = readOrReport(logPath)
  if (reportText === null || logText === null) {
    process.exit(1)
  }

  const verdict = decideUnitShardVerdict({ reportText, logText, outcome })
  for (const headline of verdict.tolerated) {
    console.log(
      `::warning::unit shard tolerated the Vitest worker teardown race (vitest-dev/vitest#11153): ${headline}`
    )
  }
  for (const problem of verdict.problems) {
    console.log(`::error::unit shard: ${problem}`)
  }
  if (!verdict.ok) {
    process.exit(1)
  }
  console.log('::notice::unit shard verdict: every test passed, no unexplained error')
}

if (process.argv[1] && process.argv[1].endsWith('check-unit-shard-verdict.mjs')) {
  main()
}
