// Fixture tests for the pure Linux-parity core. No CI, no network:
//   node --test local/lib/linux-parity.test.mjs
//
// The fixtures are shaped like Vitest's jest-format JSON reporter — the exact fields
// `local/check-unit-shard-verdict.mjs` parses — with `/home/runner/work/...` paths, because that
// is the shape a nightly shard report from ubuntu-24.04 actually has.

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatLinuxFailures,
  formatParity,
  indexShardReports,
  judgeLinuxFailures,
  judgeParity,
  judgeParityEntry,
  reportPathsFor
} from './linux-parity.mjs'

const LINUX_ROOT = '/home/runner/work/orca/orca/'

function fileResult(path, { status = 'passed', assertions = [], message = '' } = {}) {
  return { name: `${LINUX_ROOT}${path}`, status, message, assertionResults: assertions }
}

function assertion(fullName, status, failureMessages = []) {
  return { fullName, status, failureMessages }
}

function report(testResults, { numTotalTests } = {}) {
  const total =
    numTotalTests ?? testResults.reduce((sum, file) => sum + file.assertionResults.length, 0)
  return { numTotalTests: total, numFailedTests: 0, testResults }
}

function manifestOf(entries) {
  return { entries }
}

const ENTRY = {
  file: 'src/main/thing.test.ts',
  test: 'the Mac-bound case',
  class: 'sqlite-binding'
}

function indexFor(reports) {
  return indexShardReports(reports.map((r, i) => ({ source: `shard-${i}.json`, report: r })))
}

test('a test that passed on Linux satisfies its allowlisted entry', () => {
  const index = indexFor([
    report([
      fileResult('src/main/thing.test.ts', {
        assertions: [assertion('the Mac-bound case', 'passed')]
      })
    ])
  ])
  const result = judgeParity(manifestOf([ENTRY]), index)
  assert.equal(result.rows[0].status, 'passed')
  assert.equal(result.ok, true)
  assert.deepEqual(result.counts, { passed: 1, failed: 0, absent: 0 })
})

test('a test that failed on Linux fails parity, with the failure line quoted', () => {
  const index = indexFor([
    report([
      fileResult('src/main/thing.test.ts', {
        status: 'failed',
        assertions: [
          assertion('the Mac-bound case', 'failed', ['Error: something new\n  at nowhere\nmore'])
        ]
      })
    ])
  ])
  const result = judgeParity(manifestOf([ENTRY]), index)
  assert.equal(result.rows[0].status, 'failed')
  assert.match(result.rows[0].detail, /something new/)
  assert.equal(result.ok, false)
})

test("an entry's Mac-side `match` regex is not applied to the Linux outcome", () => {
  const index = indexFor([
    report([
      fileResult('src/main/thing.test.ts', {
        status: 'failed',
        assertions: [
          assertion('the Mac-bound case', 'failed', ['Error: a differently-shaped break'])
        ]
      })
    ])
  ])
  const result = judgeParity(manifestOf([{ ...ENTRY, match: 'cannot add rowid alias' }]), index)
  assert.equal(result.rows[0].status, 'failed')
})

test('a file no shard report collected makes its entry absent, not passed', () => {
  const index = indexFor([
    report([fileResult('src/other.test.ts', { assertions: [assertion('unrelated', 'passed')] })])
  ])
  const result = judgeParity(manifestOf([ENTRY]), index)
  assert.equal(result.rows[0].status, 'absent')
  assert.match(result.rows[0].detail, /no shard report collected src\/main\/thing\.test\.ts/)
  assert.match(result.rows[0].detail, /not a pass/)
  assert.equal(result.ok, false)
})

test('a file that ran but never reported the test makes its entry absent, not passed', () => {
  const index = indexFor([
    report([
      fileResult('src/main/thing.test.ts', {
        assertions: [assertion('a renamed sibling case', 'passed')]
      })
    ])
  ])
  const result = judgeParity(manifestOf([ENTRY]), index)
  assert.equal(result.rows[0].status, 'absent')
  assert.match(result.rows[0].detail, /never reported this test/)
})

test('a suite-level file failure makes the entry absent and names the collect error', () => {
  const index = indexFor([
    report([
      fileResult('src/main/thing.test.ts', {
        status: 'failed',
        message: 'Error: Failed to load src/main/thing.test.ts — does not exist'
      })
    ])
  ])
  const result = judgeParity(manifestOf([ENTRY]), index)
  assert.equal(result.rows[0].status, 'absent')
  assert.match(result.rows[0].detail, /failed at suite level/)
  assert.match(result.rows[0].detail, /not a pass/)
  assert.equal(result.ok, false)
})

test('a skipped assertion is absent — a test a beforeAll killed never ran', () => {
  const index = indexFor([
    report([
      fileResult('src/main/thing.test.ts', {
        assertions: [assertion('the Mac-bound case', 'skipped')]
      })
    ])
  ])
  const result = judgeParity(manifestOf([ENTRY]), index)
  assert.equal(result.rows[0].status, 'absent')
  assert.match(result.rows[0].detail, /reported this test as skipped/)
})

test('across node-version shards: any failure wins over a pass elsewhere', () => {
  const index = indexFor([
    report([
      fileResult('src/main/thing.test.ts', {
        assertions: [assertion('the Mac-bound case', 'passed')]
      })
    ]),
    report([
      fileResult('src/main/thing.test.ts', {
        status: 'failed',
        assertions: [assertion('the Mac-bound case', 'failed', ['Error: red on node 22 only'])]
      })
    ])
  ])
  const rows = judgeParityEntry({ ...ENTRY, key: 'k' }, index)
  assert.equal(rows.status, 'failed')
})

test('a file-level entry (*) passes on a passed file and fails on a suite-level failure', () => {
  const passed = indexFor([
    report([
      fileResult('src/main/thing.test.ts', {
        assertions: [assertion('one case', 'passed')]
      })
    ])
  ])
  const failed = indexFor([
    report([fileResult('src/main/thing.test.ts', { status: 'failed', message: 'collect error' })])
  ])
  const entry = { ...ENTRY, test: null, key: 'src/main/thing.test.ts › *' }
  assert.equal(judgeParityEntry(entry, passed).status, 'passed')
  assert.equal(judgeParityEntry(entry, failed).status, 'failed')
})

test('a file-level entry does not pass on a file whose every test was skipped', () => {
  // Why: Vitest reports an all-skipped file as `passed`, so the file status alone is not evidence that
  // anything ran on Linux.
  const skipped = indexFor([
    report([
      fileResult('src/main/thing.test.ts', {
        assertions: [assertion('one case', 'skipped'), assertion('another', 'pending')]
      })
    ])
  ])
  const entry = { ...ENTRY, test: null, key: 'src/main/thing.test.ts › *' }
  assert.equal(judgeParityEntry(entry, skipped).status, 'absent')
})

test('suffix matching is /-bounded: ba/x.test.ts never satisfies a/x.test.ts', () => {
  const files = new Map([['/repo/ba/x.test.ts', { status: 'passed', message: '', assertions: [] }]])
  assert.deepEqual(reportPathsFor(files, 'a/x.test.ts'), [])
  assert.deepEqual(reportPathsFor(files, 'ba/x.test.ts'), ['/repo/ba/x.test.ts'])
})

test('a report without testResults, or with zero tests, is a problem and fails closed', () => {
  const noResults = indexShardReports([{ source: 'shard-0.json', report: { numTotalTests: 4 } }])
  const empty = indexShardReports([{ source: 'shard-1.json', report: report([]) }])
  assert.equal(noResults.problems.length, 1)
  assert.match(noResults.problems[0], /no testResults array/)
  assert.equal(empty.problems.length, 1)
  assert.match(empty.problems[0], /holds no tests/)
  const result = judgeParity(manifestOf([ENTRY]), empty)
  assert.equal(result.ok, false)
})

test('a test result with no name cannot be attributed and says so', () => {
  const index = indexShardReports([
    {
      source: 'shard-0.json',
      report: { numTotalTests: 1, testResults: [{ status: 'passed', assertionResults: [] }] }
    }
  ])
  assert.match(index.problems[0], /no name/)
})

test('prunedSince is reported but never enforced', () => {
  const manifest = manifestOf([ENTRY])
  manifest.prunedSince = [
    {
      file: 'src/main/old.test.ts',
      test: 'a pruned case',
      class: 'bash-3.2',
      commit: 'abc',
      reason: 'x'
    }
  ]
  const index = indexFor([
    report([
      fileResult('src/main/thing.test.ts', {
        assertions: [assertion('the Mac-bound case', 'passed')]
      }),
      fileResult('src/main/old.test.ts', {
        status: 'failed',
        assertions: [assertion('a pruned case', 'failed', ['Error: red on Linux too'])]
      })
    ])
  ])
  const result = judgeParity(manifest, index)
  assert.equal(result.ok, true)
  assert.equal(result.pruned.length, 1)
  assert.equal(result.pruned[0].status, 'failed')
  const lines = formatParity(result, { allowlistPath: 'local/unit-known-red.json', reportCount: 1 })
  assert.ok(lines.some((line) => line.startsWith('prunedSince (reported, not enforced): 1 entr')))
  assert.match(lines.at(-1), /parity: PASS/)
})

test('formatParity separates failed from absent in its verdict line', () => {
  const index = indexFor([
    report([
      fileResult('src/main/thing.test.ts', {
        status: 'failed',
        assertions: [assertion('the Mac-bound case', 'failed', ['Error: break'])]
      }),
      fileResult('src/main/other.test.ts')
    ])
  ])
  const result = judgeParity(
    manifestOf([
      ENTRY,
      { file: 'src/main/other.test.ts', test: 'never ran', class: 'host-toolchain' }
    ]),
    index
  )
  const lines = formatParity(result, { allowlistPath: 'a.json', reportCount: 2 })
  assert.match(lines.at(-1), /1 failed and 1 absent of 2/)
  assert.ok(lines.some((line) => line.startsWith('  FAILED    ')))
  assert.ok(lines.some((line) => line.startsWith('  ABSENT    ')))
})

// The Linux red set. Same fixture shape and same `/home/runner/work` paths, because the question is
// whether a nightly's *other* reds are accounted for, not whether this Mac's claim transfers.
const RED_SET_ENTRY = {
  file: 'src/main/daemon/daemon-race.test.ts',
  test: 'serializes concurrent checkpoints',
  class: 'upstream-daemon-disconnect-race',
  evidence: 'failed on Linux twice and passed 3/3 on the Mac'
}

function linuxIndex(results) {
  return indexShardReports([{ source: 'shard.json', report: report(results) }])
}

test('judgeLinuxFailures passes when the only red is a listed one', () => {
  const index = linuxIndex([
    fileResult('src/main/daemon/daemon-race.test.ts', {
      status: 'failed',
      assertions: [
        assertion('DaemonPtyAdapter history recovery serializes concurrent checkpoints', 'failed', [
          'DaemonConnectionLostError: Disconnected'
        ])
      ]
    })
  ])
  const result = judgeLinuxFailures(manifestOf([RED_SET_ENTRY]), index)
  assert.equal(result.ok, true)
  assert.equal(result.allowlisted.length, 1)
  assert.equal(result.stale.length, 0)
  // Matched on a substring of the full name, because Vitest prefixes it with the describe block.
  assert.equal(result.allowlisted[0].class, 'upstream-daemon-disconnect-race')
})

test('judgeLinuxFailures fails on a red no entry accounts for', () => {
  const index = linuxIndex([
    fileResult('src/main/other.test.ts', {
      status: 'failed',
      assertions: [assertion('something broke', 'failed', ['AssertionError: nope'])]
    })
  ])
  const result = judgeLinuxFailures(manifestOf([RED_SET_ENTRY]), index)
  assert.equal(result.ok, false)
  assert.equal(result.unexpected.length, 1)
  assert.match(result.unexpected[0].detail, /nope/)
})

test('a file-level failure is never absorbed by a name-matching entry', () => {
  const index = linuxIndex([
    fileResult('src/main/daemon/daemon-race.test.ts', {
      status: 'failed',
      message: 'Error: connect ECONNREFUSED'
    })
  ])
  const result = judgeLinuxFailures(manifestOf([RED_SET_ENTRY]), index)
  assert.equal(result.ok, false)
  assert.equal(result.unexpected[0].test, null)
  // The entry matched no failure, so it is reported as prunable rather than as a false pass.
  assert.equal(result.stale.length, 1)
})

test('a listed test that passed is prunable, reported but not enforced', () => {
  const index = linuxIndex([
    fileResult('src/main/daemon/daemon-race.test.ts', {
      status: 'passed',
      assertions: [assertion('serializes concurrent checkpoints', 'passed')]
    })
  ])
  const result = judgeLinuxFailures(manifestOf([RED_SET_ENTRY]), index)
  assert.equal(result.ok, true)
  assert.equal(result.stale.length, 1)
  assert.equal(result.total, 1)
})

test('an entry with no evidence is a problem, so the set cannot become a mute button', () => {
  const result = judgeLinuxFailures(
    manifestOf([{ file: 'src/main/daemon/daemon-race.test.ts', test: 'x' }]),
    linuxIndex([])
  )
  assert.equal(result.ok, false)
  assert.match(result.problems.join(' '), /no evidence/)
})

test('a shard report that never arrived fails the run', () => {
  const reports = [{ source: 'a.json', report: report([]) }]
  const result = judgeLinuxFailures(manifestOf([RED_SET_ENTRY]), linuxIndex([]), {
    reports,
    expectedReports: 5
  })
  assert.equal(result.ok, false)
  assert.match(result.problems.join(' '), /only 1 of 5 shard report/)
})

test('a report that declares more failing tests than could be attributed fails the run', () => {
  const reports = [{ source: 'a.json', report: { ...report([]), numFailedTests: 3 } }]
  const result = judgeLinuxFailures(manifestOf([RED_SET_ENTRY]), linuxIndex([]), {
    reports,
    expectedReports: 1
  })
  assert.equal(result.ok, false)
  assert.match(result.problems.join(' '), /declare 3 failing test/)
})

test('a shard that reports failure with no failing test fails the run', () => {
  const reports = [{ source: 'a.json', report: { ...report([]), success: false } }]
  const result = judgeLinuxFailures(manifestOf([]), linuxIndex([]), { reports })
  assert.equal(result.ok, false)
  assert.match(result.problems.join(' '), /failure with no failing test/)
})

test('a sibling whose title contains the listed one is not absorbed', () => {
  const index = linuxIndex([
    fileResult('src/main/daemon/daemon-race.test.ts', {
      status: 'failed',
      assertions: [assertion('serializes concurrent checkpoints under load', 'failed', ['boom'])]
    })
  ])
  const result = judgeLinuxFailures(manifestOf([RED_SET_ENTRY]), index)
  assert.equal(result.ok, false)
  assert.equal(result.unexpected.length, 1)
})

test('a suite error alongside the listed failure is not absorbed by the entry', () => {
  const index = linuxIndex([
    fileResult('src/main/daemon/daemon-race.test.ts', {
      status: 'failed',
      message: 'Error: afterAll hook timed out',
      assertions: [assertion('serializes concurrent checkpoints', 'failed', ['boom'])]
    })
  ])
  const result = judgeLinuxFailures(manifestOf([RED_SET_ENTRY]), index)
  assert.equal(result.ok, false)
  assert.equal(result.allowlisted.length, 1)
  assert.equal(result.unexpected.length, 1)
  assert.equal(result.unexpected[0].test, null)
})

test('a short title whose full name carries a describe prefix is still found', () => {
  // The Mac allowlist stores Vitest's full name; a red-set entry stores the bare title. Matching the
  // name exactly read a test that passed as absent, and told the operator to keep a prunable entry.
  const result = judgeLinuxFailures(
    manifestOf([RED_SET_ENTRY]),
    linuxIndex([
      fileResult('src/main/daemon/daemon-race.test.ts', {
        status: 'passed',
        assertions: [
          assertion('DaemonPtyAdapter recovery serializes concurrent checkpoints', 'passed')
        ]
      })
    ])
  )
  assert.equal(result.ok, true)
  assert.equal(result.stale.length, 1)
  assert.equal(result.stale[0].status, 'passed')
  assert.match(
    formatLinuxFailures(result, { allowlistPath: 'a.json', reportCount: 1 }).join('\n'),
    /prunable/
  )
})

test('stale tells a passed entry apart from one that never ran', () => {
  const passed = judgeLinuxFailures(
    manifestOf([RED_SET_ENTRY]),
    linuxIndex([
      fileResult('src/main/daemon/daemon-race.test.ts', {
        status: 'passed',
        assertions: [assertion('serializes concurrent checkpoints', 'passed')]
      })
    ])
  )
  assert.equal(passed.stale[0].status, 'passed')
  const neverRan = judgeLinuxFailures(manifestOf([RED_SET_ENTRY]), linuxIndex([]))
  assert.equal(neverRan.stale[0].status, 'absent')
  assert.match(
    formatLinuxFailures(neverRan, { allowlistPath: 'a.json', reportCount: 1 }).join('\n'),
    /no evidence/
  )
})
