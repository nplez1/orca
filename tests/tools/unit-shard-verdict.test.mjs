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

function report({
  totalTests = 100,
  failedTests = 0,
  failedSuites = 0,
  failing = [],
  passing = [],
  fileLevelFailures = []
} = {}) {
  return JSON.stringify({
    numTotalTestSuites: failedSuites + passing.length + fileLevelFailures.length + 1,
    numFailedTestSuites: failedSuites + fileLevelFailures.length,
    numTotalTests: totalTests,
    numFailedTests: failedTests,
    success: failedTests === 0 && failedSuites === 0,
    testResults: [
      ...failing.map(([name, fullName, message]) => ({
        name,
        status: 'failed',
        ...(message ? { message } : {}),
        assertionResults: [{ status: 'failed', title: fullName, fullName }]
      })),
      ...passing.map(([name, fullName = 'passes']) => ({
        name,
        status: 'passed',
        assertionResults: [{ status: 'passed', title: fullName, fullName }]
      })),
      ...fileLevelFailures.map((name) => ({ name, status: 'failed', assertionResults: [] }))
    ]
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
  expect(verdict).toEqual({
    ok: true,
    tolerated: [TOLERATED_UNHANDLED_ERROR],
    absorbed: [],
    prunable: [],
    problems: []
  })
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
  expect(verdict.problems).toEqual([
    'failing: src/main/ipc/worktrees-detected-scan-cache.test.ts › stops re-scanning'
  ])
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

function run(reportText, logText, outcome, knownRed = []) {
  const dir = mkdtempSync(join(tmpdir(), 'unit-shard-verdict-'))
  dirs.push(dir)
  const reportPath = join(dir, 'report.json')
  const logPath = join(dir, 'shard.log')
  // Why always written, even when empty: otherwise a run on Linux falls back to the repo's real
  // manifest and the test means something different on CI than it does here.
  const knownRedPath = join(dir, 'known-red.json')
  writeFileSync(reportPath, reportText)
  writeFileSync(logPath, logText)
  writeFileSync(knownRedPath, JSON.stringify({ entries: knownRed }))
  const args = [SCRIPT, reportPath, logPath, outcome, '--known-red', knownRedPath]
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, args, {
        encoding: 'utf8'
      })
    }
  } catch (error) {
    return { status: error.status, stdout: `${error.stdout}${error.stderr}` }
  }
}

function runRaw(args) {
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
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
  expect(result.stdout).toContain(
    '::error::unit shard: the report declares 2 failing test(s) but lists 1; failing closed'
  )
  expect(result.stdout).toContain('::error::unit shard: failing: src/a.test.ts › does the thing')
})

it('exits zero when the only failure is a listed known red, and names the entry', () => {
  const result = run(
    report({ failedTests: 1, failedSuites: 1, failing: [['src/a.test.ts', 'serializes both']] }),
    log(),
    'failure',
    [{ file: 'src/a.test.ts', test: 'serializes both', class: 'upstream-race' }]
  )

  expect(result.status).toBe(0)
  expect(result.stdout).toContain('tolerated a known Linux red, already triaged')
  expect(result.stdout).toContain('[upstream-race]')
  expect(result.stdout).toContain('every test passed apart from 1 known red(s)')
  expect(result.stdout).not.toContain('::error::')
  expect(result.stdout).not.toContain('prunable')
})

it('still exits non-zero for an unlisted failure beside a listed one', () => {
  const result = run(
    report({
      failedTests: 2,
      failedSuites: 2,
      failing: [
        ['src/a.test.ts', 'serializes both'],
        ['src/b.test.ts', 'adds the total']
      ]
    }),
    log(),
    'failure',
    [{ file: 'src/a.test.ts', test: 'serializes both', class: 'upstream-race' }]
  )

  expect(result.status).toBe(1)
  expect(result.stdout).toContain('::error::unit shard: failing: src/b.test.ts › adds the total')
  expect(result.stdout).not.toContain('::error::unit shard: failing: src/a.test.ts')
})

it('notes a listed entry whose file passed here, so a stale entry can be pruned', () => {
  const result = run(
    report({ passing: [['src/a.test.ts', 'DaemonPtyAdapter recovery serializes both']] }),
    log(),
    'success',
    [{ file: 'src/a.test.ts', test: 'serializes both', class: 'upstream-race' }]
  )

  expect(result.status).toBe(0)
  expect(result.stdout).toContain('did not fail here, so its known-red entry may be prunable')
})

it('does not call an entry prunable when its file ran but the test never did', () => {
  const result = run(
    report({ passing: [['src/a.test.ts', 'some other test']] }),
    log(),
    'success',
    [{ file: 'src/a.test.ts', test: 'serializes both', class: 'upstream-race' }]
  )

  expect(result.status).toBe(0)
  expect(result.stdout).not.toContain('prunable')
})

it('does not let a named entry absorb a file-level failure in the same file', () => {
  // The tolerated test did not fail here, so something before or outside it did — a new red.
  const result = run(report({ fileLevelFailures: ['src/a.test.ts'] }), log(), 'failure', [
    { file: 'src/a.test.ts', test: 'serializes both', class: 'upstream-race' }
  ])

  expect(result.status).toBe(1)
  expect(result.stdout).toContain(
    '::error::unit shard: failing file (no test accounts for it): src/a.test.ts'
  )
})

it('lets a whole-file entry absorb a file-level failure', () => {
  const result = run(report({ fileLevelFailures: ['src/a.test.ts'] }), log(), 'failure', [
    { file: 'src/a.test.ts', test: null, class: 'env-bound' }
  ])

  expect(result.status).toBe(0)
  expect(result.stdout).toContain('tolerated a known Linux red')
})

it('still fails when a known red and a file-level error land in the same file', () => {
  // The BLOCKER from review: the file-level check only looked at files where no row failed, so an
  // afterAll error beside an absorbed red read as green. One file entry carries both, as Vitest
  // reports it: a failed row and a `message`.
  const result = run(
    report({
      failedTests: 1,
      failedSuites: 1,
      failing: [['src/a.test.ts', 'serializes both', 'Error: afterAll hook timed out']]
    }),
    log(),
    'failure',
    [{ file: 'src/a.test.ts', test: 'serializes both', class: 'upstream-race' }]
  )

  expect(result.status).toBe(1)
  expect(result.stdout).toContain('::error::unit shard: failing file (no test accounts for it)')
  expect(result.stdout).not.toContain('every test passed apart from')
})

it('absorbs a red whose full name carries the describe prefix, as Vitest reports it', () => {
  const result = run(
    report({
      failedTests: 1,
      failedSuites: 1,
      failing: [['src/a.test.ts', 'DaemonPtyAdapter recovery serializes both']]
    }),
    log(),
    'failure',
    [{ file: 'src/a.test.ts', test: 'serializes both', class: 'upstream-race' }]
  )

  expect(result.status).toBe(0)
  expect(result.stdout).toContain('[upstream-race]')
})

it('lets a whole-file entry absorb failing rows too, not only a file-level error', () => {
  const result = run(
    report({ failedTests: 1, failedSuites: 1, failing: [['src/a.test.ts', 'anything at all']] }),
    log(),
    'failure',
    [{ file: 'src/a.test.ts', test: null, class: 'env-bound' }]
  )

  expect(result.status).toBe(0)
  expect(result.stdout).toContain('tolerated a known Linux red')
})

it('treats --known-red without a path as a usage error, not as no manifest', () => {
  const result = runRaw(['report.json', 'shard.log', 'failure', '--known-red'])

  expect(result.status).toBe(2)
  expect(result.stdout).toContain('--known-red needs a path')
})

it('fails when the named manifest is missing or malformed', () => {
  expect(
    runRaw(['report.json', 'shard.log', 'failure', '--known-red', '/nonexistent/x.json']).status
  ).toBe(1)
  const dir = mkdtempSync(join(tmpdir(), 'unit-shard-verdict-'))
  dirs.push(dir)
  const malformed = join(dir, 'bad.json')
  writeFileSync(malformed, '{"entries": "not an array"}')
  expect(runRaw(['report.json', 'shard.log', 'failure', '--known-red', malformed]).status).toBe(1)
})

it('does not read a shared filename in a sibling directory as the listed file', () => {
  const result = run(
    report({
      failedTests: 1,
      failedSuites: 1,
      failing: [['src/other/a.test.ts', 'serializes both']]
    }),
    log(),
    'failure',
    [{ file: 'src/a.test.ts', test: 'serializes both', class: 'upstream-race' }]
  )

  expect(result.status).toBe(1)
  expect(result.stdout).toContain('::error::unit shard: failing: src/other/a.test.ts')
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
