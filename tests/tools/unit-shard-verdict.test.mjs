import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  TOLERATED_UNHANDLED_ERROR,
  collectUnhandledErrors
} from '../../local/check-unit-shard-verdict.mjs'
import {
  CANCELED,
  CANCELED_ENTRY,
  POOL_CRASH,
  POOL_CRASH_ENTRY,
  SCRIPT,
  cleanupTempDirs,
  decide,
  log,
  report,
  run,
  runRaw,
  tempDir
} from './unit-shard-verdict-harness.mjs'

afterEach(cleanupTempDirs)

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
      failing: [
        [
          'src/main/ipc/worktrees/listing/persisted-worktree-scan-cache.test.ts',
          'stops re-scanning'
        ]
      ]
    }),
    logText: log({ errors: [TOLERATED_UNHANDLED_ERROR] }),
    outcome: 'failure'
  })

  expect(verdict.ok).toBe(false)
  expect(verdict.problems).toEqual([
    'failing: src/main/ipc/worktrees/listing/persisted-worktree-scan-cache.test.ts › stops re-scanning'
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

it('does not let a tolerated pool crash explain a failed shard on its own', () => {
  const verdict = decide({
    logText: log({ errors: [POOL_CRASH] }),
    outcome: 'failure',
    unhandledErrors: [POOL_CRASH_ENTRY]
  })

  expect(verdict.tolerated).toEqual([POOL_CRASH])
  expect(verdict.ok).toBe(false)
  expect(verdict.problems).toEqual([
    `the shard failed and nothing absorbed accounts for its worker crash, which can lose tests the report still lists: ${POOL_CRASH}`
  ])
})

it('does not let a bystander tolerated error explain a shard that also crashed', () => {
  // Why: a crash beside a benign teardown headline used to read as explained, because only "every
  // tolerated headline" was consulted, not the crash itself.
  const verdict = decide({
    logText: log({ errors: [POOL_CRASH, CANCELED] }),
    outcome: 'failure',
    unhandledErrors: [POOL_CRASH_ENTRY, CANCELED_ENTRY]
  })

  expect(verdict.tolerated).toEqual([POOL_CRASH, CANCELED])
  expect(verdict.ok).toBe(false)
  expect(verdict.problems).toEqual([
    `the shard failed and nothing absorbed accounts for its worker crash, which can lose tests the report still lists: ${POOL_CRASH}`
  ])
})

it('lets a pool crash stand beside an absorbed known red that already explains the failure', () => {
  const verdict = decide({
    reportText: report({
      failedTests: 1,
      failedSuites: 1,
      failing: [['src/a.test.ts', 'serializes both', 'Error: Disconnected out of disconnectOnly()']]
    }),
    logText: log({ errors: [POOL_CRASH] }),
    outcome: 'failure',
    knownRed: [
      {
        file: 'src/a.test.ts',
        test: 'serializes both',
        class: 'upstream-race',
        match: '^Disconnected out of disconnectOnly\\(\\)'
      }
    ],
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

it('pins the pool-crash entry as one that cannot explain a failed shard', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../../local/nightly-linux-known-red.json', import.meta.url), 'utf8')
  )
  const crash = manifest.unhandledErrors.find((entry) => entry.class === 'pool-crash')

  expect(crash?.explainsFailure).toBe(false)
})

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
    report({
      failedTests: 1,
      failedSuites: 1,
      failing: [['src/a.test.ts', 'serializes both', 'Error: Disconnected out of disconnectOnly()']]
    }),
    log(),
    'failure',
    [
      {
        file: 'src/a.test.ts',
        test: 'serializes both',
        class: 'upstream-race',
        match: '^Disconnected out of disconnectOnly\\(\\)'
      }
    ]
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
        ['src/a.test.ts', 'serializes both', 'Error: Disconnected out of disconnectOnly()'],
        ['src/b.test.ts', 'adds the total']
      ]
    }),
    log(),
    'failure',
    [
      {
        file: 'src/a.test.ts',
        test: 'serializes both',
        class: 'upstream-race',
        match: '^Disconnected out of disconnectOnly\\(\\)'
      }
    ]
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
    [
      {
        file: 'src/a.test.ts',
        test: 'DaemonPtyAdapter recovery serializes both',
        class: 'upstream-race',
        match: '^Disconnected out of disconnectOnly\\(\\)'
      }
    ]
  )

  expect(result.status).toBe(0)
  expect(result.stdout).toContain('did not fail here, so its known-red entry may be prunable')
})

it('does not call an entry prunable when its file ran but the test never did', () => {
  const result = run(
    report({ passing: [['src/a.test.ts', 'some other test']] }),
    log(),
    'success',
    [
      {
        file: 'src/a.test.ts',
        test: 'serializes both',
        class: 'upstream-race',
        match: '^Disconnected out of disconnectOnly\\(\\)'
      }
    ]
  )

  expect(result.status).toBe(0)
  expect(result.stdout).not.toContain('prunable')
})

it('does not let a named entry absorb a file-level failure in the same file', () => {
  // The tolerated test did not fail here, so something before or outside it did — a new red.
  const result = run(
    report({ fileLevelFailures: [['src/a.test.ts', 'Error: connect ECONNREFUSED']] }),
    log(),
    'failure',
    [
      {
        file: 'src/a.test.ts',
        test: 'serializes both',
        class: 'upstream-race',
        match: '^Disconnected out of disconnectOnly\\(\\)'
      }
    ]
  )

  expect(result.status).toBe(1)
  expect(result.stdout).toContain(
    '::error::unit shard: failing file (no test accounts for it): src/a.test.ts'
  )
})

it('lets a whole-file entry absorb a file-level failure', () => {
  const result = run(
    report({ fileLevelFailures: [['src/a.test.ts', 'Error: connect ECONNREFUSED']] }),
    log(),
    'failure',
    [{ file: 'src/a.test.ts', test: null, class: 'env-bound', match: '^connect ECONNREFUSED' }]
  )

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
      failing: [
        ['src/a.test.ts', 'serializes both', 'Error: Disconnected out of disconnectOnly()']
      ],
      suiteMessages: [['src/a.test.ts', 'Error: afterAll hook timed out']]
    }),
    log(),
    'failure',
    [
      {
        file: 'src/a.test.ts',
        test: 'serializes both',
        class: 'upstream-race',
        match: '^Disconnected out of disconnectOnly\\(\\)'
      }
    ]
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
      failing: [
        ['src/a.test.ts', 'DaemonPtyAdapter recovery serializes both', 'Error: Disconnected']
      ]
    }),
    log(),
    'failure',
    [
      {
        file: 'src/a.test.ts',
        test: 'DaemonPtyAdapter recovery serializes both',
        class: 'upstream-race',
        match: '^Disconnected$'
      }
    ]
  )

  expect(result.status).toBe(0)
  expect(result.stdout).toContain('[upstream-race]')
})

it('does not absorb a red whose entry stores only the bare title (#317)', () => {
  // Why: the suffix match that used to absorb this is what let one entry cover every sibling whose
  // title ended the same way. The manifest stores Vitest's full name instead.
  const result = run(
    report({
      failedTests: 1,
      failedSuites: 1,
      failing: [
        ['src/a.test.ts', 'DaemonPtyAdapter recovery serializes both', 'Error: Disconnected']
      ]
    }),
    log(),
    'failure',
    [
      {
        file: 'src/a.test.ts',
        test: 'serializes both',
        class: 'upstream-race',
        match: '^Disconnected$'
      }
    ]
  )

  expect(result.status).toBe(1)
  expect(result.stdout).toContain(
    '::error::unit shard: failing: src/a.test.ts › DaemonPtyAdapter recovery serializes both'
  )
})

it('reports a listed test that failed for a new cause as its own problem', () => {
  const result = run(
    report({
      failedTests: 1,
      failedSuites: 1,
      failing: [['src/a.test.ts', 'serializes both', 'Error: TypeError: totally new bug']]
    }),
    log(),
    'failure',
    [
      {
        file: 'src/a.test.ts',
        test: 'serializes both',
        class: 'upstream-race',
        match: '^Disconnected out of disconnectOnly\\(\\)'
      }
    ]
  )

  expect(result.status).toBe(1)
  expect(result.stdout).toContain('::error::unit shard: listed test failed for a new cause')
  expect(result.stdout).toContain('TypeError: totally new bug')
  // Not prunable: the test is still red, so the entry is still doing work.
  expect(result.stdout).not.toContain('may be prunable')
})

it('refuses to judge a manifest entry that cannot pin a cause', () => {
  const result = run(
    report({ passing: [['src/a.test.ts', 'serializes both']] }),
    log(),
    'success',
    [{ file: 'src/a.test.ts', test: 'serializes both', class: 'upstream-race' }]
  )

  expect(result.status).toBe(1)
  expect(result.stdout).toContain('has no match and is not flaky')
})

it('refuses an entry whose match is not a usable regex', () => {
  const result = run(
    report({ passing: [['src/a.test.ts', 'serializes both']] }),
    log(),
    'success',
    [{ file: 'src/a.test.ts', test: 'serializes both', class: 'upstream-race', match: '(' }]
  )

  expect(result.status).toBe(1)
  expect(result.stdout).toContain('unusable match')
})

it('lets a whole-file entry absorb failing rows too, not only a file-level error', () => {
  const result = run(
    report({
      failedTests: 1,
      failedSuites: 1,
      failing: [['src/a.test.ts', 'anything at all', 'Error: keychain unavailable']]
    }),
    log(),
    'failure',
    [{ file: 'src/a.test.ts', test: null, class: 'env-bound', match: '^keychain unavailable' }]
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
  const dir = tempDir()
  const malformed = join(dir, 'bad.json')
  writeFileSync(malformed, '{"entries": "not an array"}')
  expect(runRaw(['report.json', 'shard.log', 'failure', '--known-red', malformed]).status).toBe(1)
})

it('does not read a shared filename in a sibling directory as the listed file', () => {
  const result = run(
    report({
      failedTests: 1,
      failedSuites: 1,
      failing: [['src/other/a.test.ts', 'serializes both', 'Error: Disconnected']]
    }),
    log(),
    'failure',
    [
      {
        file: 'src/a.test.ts',
        test: 'serializes both',
        class: 'upstream-race',
        match: '^Disconnected$'
      }
    ]
  )

  expect(result.status).toBe(1)
  expect(result.stdout).toContain('::error::unit shard: failing: src/other/a.test.ts')
})

it('exits non-zero when the shard failed on a tolerated crash and nothing else', () => {
  const result = run(report(), log({ errors: [POOL_CRASH] }), 'failure', [], {
    unhandledErrors: [POOL_CRASH_ENTRY]
  })

  expect(result.status).toBe(1)
  expect(result.stdout).toContain(
    '::warning::unit shard tolerated a listed run-level error [pool-crash]'
  )
  expect(result.stdout).toContain('nothing absorbed accounts for its worker crash')
})

it('rejects a manifest whose explainsFailure is not a boolean', () => {
  const result = run(report(), log(), 'success', [], {
    unhandledErrors: [{ ...POOL_CRASH_ENTRY, explainsFailure: 'no' }]
  })

  expect(result.status).toBe(1)
  expect(result.stdout).toContain('an unhandledErrors entry has a non-boolean explainsFailure')
})

it('fails when the report is missing, so a crashed run cannot pass as green', () => {
  const dir = tempDir()
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
