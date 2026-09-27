import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  TOLERATED_UNHANDLED_ERROR,
  collectUnhandledErrors,
  decideUnitShardVerdict
} from '../../local/check-unit-shard-verdict.mjs'

const SCRIPT = new URL('../../local/check-unit-shard-verdict.mjs', import.meta.url).pathname
const dirs = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function report({ totalTests = 100, failedTests = 0, failedSuites = 0, failing = [] } = {}) {
  return JSON.stringify({
    numTotalTestSuites: failedSuites + 1,
    numFailedTestSuites: failedSuites,
    numTotalTests: totalTests,
    numFailedTests: failedTests,
    success: failedTests === 0 && failedSuites === 0,
    testResults: failing.map(([name, fullName]) => ({
      name,
      status: 'failed',
      assertionResults: [{ status: 'failed', title: fullName, fullName }]
    }))
  })
}

function log({ errors = [], declaredCount = errors.length } = {}) {
  if (declaredCount === 0) {
    return ' Test Files  1192 passed (1204)\n      Tests  12231 passed (12313)\n'
  }
  const blocks = errors
    .map(
      (headline) =>
        `\u2500\u2500\u2500\u2500\u2500\u2500 Unhandled Rejection \u2500\u2500\u2500\u2500\u2500\u2500\n` +
        `\u001b[31m\u001b[1m${headline}\u001b[22m\u001b[39m\n` +
        `This error originated in "src/main/ipc/worktrees-detected-scan-cache.test.ts" test file.`
    )
    .join('\n')
  return (
    `\u2500\u2500\u2500\u2500\u2500\u2500 Unhandled Errors \u2500\u2500\u2500\u2500\u2500\u2500\n` +
    `Vitest caught ${declaredCount} unhandled error${declaredCount === 1 ? '' : 's'} during the test run.\n` +
    `This might cause false positive tests.\n${blocks}\n` +
    ` Test Files  1192 passed (1204)\n      Tests  12231 passed (12313)\n     Errors  ${declaredCount} error\n`
  )
}

const decide = (overrides = {}) =>
  decideUnitShardVerdict({
    reportText: report(),
    logText: log(),
    outcome: 'success',
    ...overrides
  })

it('reads the teardown race out of the log and tolerates exactly it', () => {
  const collected = collectUnhandledErrors(log({ errors: [TOLERATED_UNHANDLED_ERROR] }))

  expect(collected.sectionPresent).toBe(true)
  expect(collected.declaredCount).toBe(1)
  expect(collected.headlines).toEqual([TOLERATED_UNHANDLED_ERROR])
  const verdict = decide({
    logText: log({ errors: [TOLERATED_UNHANDLED_ERROR] }),
    outcome: 'failure'
  })
  expect(verdict).toEqual({ ok: true, tolerated: [TOLERATED_UNHANDLED_ERROR], problems: [] })
})

it('tolerates the race when two workers close at once', () => {
  const verdict = decide({
    logText: log({ errors: [TOLERATED_UNHANDLED_ERROR, TOLERATED_UNHANDLED_ERROR] }),
    outcome: 'failure'
  })

  expect(verdict.ok).toBe(true)
  expect(verdict.tolerated).toHaveLength(2)
})

it('fails on any other unhandled error', () => {
  const verdict = decide({
    logText: log({
      errors: [
        TOLERATED_UNHANDLED_ERROR,
        "TypeError: Cannot read properties of undefined (reading 'id')"
      ]
    }),
    outcome: 'failure'
  })

  expect(verdict.ok).toBe(false)
  expect(verdict.problems).toContain(
    "unhandled error: TypeError: Cannot read properties of undefined (reading 'id')"
  )
})

it('fails closed when the log holds fewer errors than Vitest counted', () => {
  const verdict = decide({
    logText: log({ errors: [TOLERATED_UNHANDLED_ERROR], declaredCount: 2 }),
    outcome: 'failure'
  })

  expect(verdict.ok).toBe(false)
  expect(verdict.problems.some((problem) => problem.includes('failing closed'))).toBe(true)
})

it('fails on a failed test even while the teardown race is present', () => {
  const verdict = decide({
    reportText: report({
      failedTests: 1,
      failedSuites: 1,
      failing: [['src/main/ipc/worktrees-detected-scan-cache.test.ts', 'stops re-scanning']]
    }),
    logText: log({ errors: [TOLERATED_UNHANDLED_ERROR] }),
    outcome: 'failure'
  })

  expect(verdict.ok).toBe(false)
  expect(verdict.problems).toContain('1 test(s) failed')
  expect(verdict.problems).toContain(
    'failing: src/main/ipc/worktrees-detected-scan-cache.test.ts › stops re-scanning'
  )
})

it('fails when the shard failed with nothing to explain it', () => {
  const verdict = decide({ outcome: 'failure' })

  expect(verdict.ok).toBe(false)
  expect(verdict.problems).toContain('the shard failed without the tolerated Vitest teardown race')
})

it('fails when the report is unreadable or holds no tests', () => {
  expect(decide({ reportText: '' }).problems).toContain(
    'the Vitest JSON report is missing or unreadable, so nothing proves the shard ran'
  )
  expect(decide({ reportText: report({ totalTests: 0 }) }).problems).toContain(
    'the report holds no tests, so the shard cannot be judged green'
  )
})

it('fails on an outcome it cannot judge', () => {
  expect(decide({ outcome: 'cancelled' }).problems).toContain(
    'unknown test-step outcome "cancelled"'
  )
})

function run(reportText, logText, outcome) {
  const dir = mkdtempSync(join(tmpdir(), 'unit-shard-verdict-'))
  dirs.push(dir)
  const reportPath = join(dir, 'report.json')
  const logPath = join(dir, 'shard.log')
  writeFileSync(reportPath, reportText)
  writeFileSync(logPath, logText)
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, [SCRIPT, reportPath, logPath, outcome], {
        encoding: 'utf8'
      })
    }
  } catch (error) {
    return { status: error.status, stdout: `${error.stdout}${error.stderr}` }
  }
}

it('exits zero for a tolerated race and warns with the upstream issue', () => {
  const result = run(report(), log({ errors: [TOLERATED_UNHANDLED_ERROR] }), 'failure')

  expect(result.status).toBe(0)
  expect(result.stdout).toContain('::warning::unit shard tolerated the Vitest worker teardown race')
  expect(result.stdout).toContain('vitest-dev/vitest#11153')
})

it('exits non-zero for a real failure and names it', () => {
  const result = run(
    report({ failedTests: 2, failedSuites: 1, failing: [['src/a.test.ts', 'does the thing']] }),
    log(),
    'failure'
  )

  expect(result.status).toBe(1)
  expect(result.stdout).toContain('::error::unit shard: 1 test file(s) failed')
  expect(result.stdout).toContain('::error::unit shard: failing: src/a.test.ts › does the thing')
})

it('fails when the report is missing, so a crashed run cannot pass as green', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unit-shard-verdict-'))
  dirs.push(dir)
  const logPath = join(dir, 'shard.log')
  writeFileSync(logPath, log())
  let failed = false
  try {
    execFileSync(process.execPath, [SCRIPT, join(dir, 'missing.json'), logPath, 'failure'], {
      stdio: 'pipe'
    })
  } catch (error) {
    failed = true
    expect(String(error.stderr)).toContain('cannot read')
  }
  expect(failed).toBe(true)
})
