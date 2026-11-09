import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  TOLERATED_UNHANDLED_ERROR,
  collectUnhandledErrors,
  decideUnitShardVerdict,
  readShardAssignment
} from '../../local/check-unit-shard-verdict.mjs'

const SCRIPT = new URL('../../local/check-unit-shard-verdict.mjs', import.meta.url).pathname
const REPO_ROOT = new URL('../../', import.meta.url).pathname
// Verbatim what Vitest's pool prints, and the entry the Linux manifest tolerates it with.
const POOL_CRASH = 'Error: [vitest-pool]: Worker node-runtime emitted error.'
const POOL_CRASH_ENTRY = {
  match: '^Error: \\[vitest-pool\\]: Worker node-runtime emitted error\\.$',
  class: 'pool-crash',
  explainsFailure: false
}
const CANCELED = 'Canceled: Canceled'
const CANCELED_ENTRY = { match: '^Canceled: Canceled$', class: 'third-party-teardown' }
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

it('fails when an assigned file is missing from the report', () => {
  const verdict = decide({
    reportText: report({ totalTests: 1, passing: [['src/a.test.ts', 'runs']] }),
    assignedFiles: ['src/a.test.ts', 'src/b.test.ts']
  })

  expect(verdict.ok).toBe(false)
  expect(verdict.problems).toEqual([
    'the report does not name 1 file(s) the lane should have run: src/b.test.ts'
  ])
})

it('passes when the report names every assigned file', () => {
  const verdict = decide({
    reportText: report({
      passing: [
        ['src/a.test.ts', 'runs'],
        ['src/b.test.ts', 'runs']
      ]
    }),
    assignedFiles: ['src/a.test.ts', 'src/b.test.ts']
  })

  expect(verdict).toEqual({ ok: true, tolerated: [], absorbed: [], prunable: [], problems: [] })
})

it('matches an absolute CI report path against a repo-relative assignment', () => {
  const verdict = decide({
    reportText: report({ passing: [[`${REPO_ROOT}src/a.test.ts`, 'runs']] }),
    assignedFiles: ['src/a.test.ts']
  })

  expect(verdict.ok).toBe(true)
})

it('fails when the report names a file the shard was not assigned', () => {
  const verdict = decide({
    reportText: report({
      passing: [
        ['src/a.test.ts', 'runs'],
        ['src/other.test.ts', 'runs']
      ]
    }),
    assignedFiles: ['src/a.test.ts']
  })

  expect(verdict.ok).toBe(false)
  expect(verdict.problems).toEqual([
    'the report names 1 file(s) this shard was not assigned, so the assignment does not describe this run: src/other.test.ts'
  ])
})

it('fails when the assignment gives the shard no files', () => {
  const verdict = decide({ assignedFiles: [] })

  expect(verdict.ok).toBe(false)
  expect(verdict.problems).toContain(
    'the shard assignment gives this shard no files, so nothing proves what it should have run'
  )
})

it('does not let a tolerated pool crash explain a failed shard on its own', () => {
  const verdict = decide({
    logText: log({ errors: [POOL_CRASH] }),
    outcome: 'failure',
    unhandledErrors: [POOL_CRASH_ENTRY]
  })

  expect(verdict.tolerated).toEqual([POOL_CRASH])
  expect(verdict.ok).toBe(false)
  expect(verdict.problems).toEqual([
    `the shard failed and its only tolerated error cannot account for it — a worker crash can lose tests the report still lists: ${POOL_CRASH}`
  ])
})

it('lets a pool crash stand beside an absorbed known red that already explains the failure', () => {
  const verdict = decide({
    reportText: report({
      failedTests: 1,
      failedSuites: 1,
      failing: [['src/a.test.ts', 'serializes both']]
    }),
    logText: log({ errors: [POOL_CRASH] }),
    outcome: 'failure',
    knownRed: [{ file: 'src/a.test.ts', test: 'serializes both', class: 'upstream-race' }],
    unhandledErrors: [POOL_CRASH_ENTRY]
  })

  expect(verdict.ok).toBe(true)
  expect(verdict.absorbed).toEqual(['src/a.test.ts › serializes both [upstream-race]'])
})

it('keeps a tolerated run-level error able to explain a failed shard by itself', () => {
  const verdict = decide({
    logText: log({ errors: [CANCELED] }),
    outcome: 'failure',
    unhandledErrors: [CANCELED_ENTRY]
  })

  expect(verdict.ok).toBe(true)
  expect(verdict.tolerated).toEqual([CANCELED])
})

it('reads the selected shard out of the sequencer manifest and rejects a stale one', () => {
  const assignment = {
    runId: '1',
    runAttempt: '1',
    selectedShard: 2,
    shards: [{ files: ['src/a.test.ts'] }, { files: ['src/b.test.ts'] }]
  }
  const text = JSON.stringify(assignment)

  expect(readShardAssignment(text, { runId: '1', runAttempt: '1' })).toEqual({
    files: ['src/b.test.ts']
  })
  expect(readShardAssignment(text, { runId: '2', runAttempt: '1' }).problem).toContain(
    'from runId 1, not this one (2)'
  )
  expect(readShardAssignment(text, { runId: '1', runAttempt: '2' }).problem).toContain(
    'from runAttempt 1, not this one (2)'
  )
  expect(readShardAssignment('not json').problem).toContain('unreadable')
  expect(readShardAssignment(JSON.stringify({ shards: [] })).problem).toContain('holds no shards')
  expect(
    readShardAssignment(JSON.stringify({ shards: [{ files: ['a'] }], selectedShard: 3 })).problem
  ).toContain('which is not one of its 1 shard(s)')
  expect(
    readShardAssignment(JSON.stringify({ shards: [{ files: 'a' }], selectedShard: 1 })).problem
  ).toContain('no usable file list')
})

it('pins the pool-crash entry as one that cannot explain a failed shard', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../../local/nightly-linux-known-red.json', import.meta.url), 'utf8')
  )
  const crash = manifest.unhandledErrors.find((entry) => entry.class === 'pool-crash')

  expect(crash?.explainsFailure).toBe(false)
})

function run(
  reportText,
  logText,
  outcome,
  knownRed = [],
  { unhandledErrors = [], assignment = null } = {}
) {
  const dir = mkdtempSync(join(tmpdir(), 'unit-shard-verdict-'))
  dirs.push(dir)
  const reportPath = join(dir, 'report.json')
  const logPath = join(dir, 'shard.log')
  // Why always written, even when empty: otherwise a run on Linux falls back to the repo's real
  // manifest and the test means something different on CI than it does here.
  const knownRedPath = join(dir, 'known-red.json')
  writeFileSync(reportPath, reportText)
  writeFileSync(logPath, logText)
  writeFileSync(knownRedPath, JSON.stringify({ entries: knownRed, unhandledErrors }))
  const args = [SCRIPT, reportPath, logPath, outcome, '--known-red', knownRedPath]
  if (assignment !== null) {
    const assignmentPath = join(dir, 'unit-assignment.json')
    writeFileSync(
      assignmentPath,
      typeof assignment === 'string' ? assignment : JSON.stringify(assignment)
    )
    args.push('--assignment', assignmentPath)
  }
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

it('exits zero when the assignment accounts for every file in the report', () => {
  const result = run(
    report({ totalTests: 2, passing: [['src/a.test.ts', 'runs']] }),
    log(),
    'success',
    [],
    { assignment: { selectedShard: 1, shards: [{ files: ['src/a.test.ts'] }] } }
  )

  expect(result.status).toBe(0)
})

it('exits non-zero when an assigned file is absent from the report', () => {
  const result = run(
    report({ totalTests: 2, passing: [['src/a.test.ts', 'runs']] }),
    log(),
    'success',
    [],
    { assignment: { selectedShard: 1, shards: [{ files: ['src/a.test.ts', 'src/b.test.ts'] }] } }
  )

  expect(result.status).toBe(1)
  expect(result.stdout).toContain(
    '::error::unit shard: the report does not name 1 file(s) the lane should have run: src/b.test.ts'
  )
})

it('exits non-zero when the shard failed on a tolerated crash and nothing else', () => {
  const result = run(report(), log({ errors: [POOL_CRASH] }), 'failure', [], {
    unhandledErrors: [POOL_CRASH_ENTRY]
  })

  expect(result.status).toBe(1)
  expect(result.stdout).toContain(
    '::warning::unit shard tolerated a listed run-level error [pool-crash]'
  )
  expect(result.stdout).toContain('its only tolerated error cannot account for it')
})

it('exits non-zero when the assignment cannot be read or does not describe a shard', () => {
  const malformed = run(report(), log(), 'success', [], { assignment: 'not json' })

  expect(malformed.status).toBe(1)
  expect(malformed.stdout).toContain('::error::unit shard: the shard assignment is unreadable')

  const dir = mkdtempSync(join(tmpdir(), 'unit-shard-verdict-'))
  dirs.push(dir)
  const reportPath = join(dir, 'report.json')
  const logPath = join(dir, 'shard.log')
  writeFileSync(reportPath, report())
  writeFileSync(logPath, log())
  const absent = runRaw([
    reportPath,
    logPath,
    'success',
    '--assignment',
    join(dir, 'missing-assignment.json')
  ])

  expect(absent.status).toBe(1)
  expect(absent.stdout).toContain('::error::unit shard: cannot read the shard assignment')
})

it('treats --assignment without a path as a usage error, not as no assignment', () => {
  const result = runRaw(['report.json', 'shard.log', 'failure', '--assignment'])

  expect(result.status).toBe(2)
  expect(result.stdout).toContain('--assignment needs a path')
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
