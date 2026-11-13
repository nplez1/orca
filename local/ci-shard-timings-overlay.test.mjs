// The overlay's contract with the shard planner: which files it may carry, that a collision with the
// baseline is stale, that a malformed overlay stops the planner instead of scheduling blind, and that
// an artifact set which cannot be trusted is refused rather than summed. Fixture trees plus one pass
// over the committed files.
//
//   node --test local/ci-shard-timings-overlay.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readTimingBaseline } from '../config/scripts/ci/sharding/ci-shard-assignment.mjs'
import {
  assertOverlayShape,
  mergeForkTimingOverlay,
  OVERLAY_PATH
} from './ci-shard-timings-overlay-merge.mjs'
import {
  parseArgs,
  overlayProblems,
  readArtifacts,
  selectEntries,
  simulateLoads,
  summariseLoads
} from './ci-shard-timings-overlay.mjs'

const BASELINE_TIMINGS = { 'src/upstream.test.ts': 900 }
const BASELINE_BYTES = readFileSync(
  new URL('../config/scripts/ci/sharding/ci-shard-timings.json', import.meta.url),
  'utf8'
)
const REAL_BASELINE = JSON.parse(BASELINE_BYTES)

function fixtureRoot(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orca-shard-overlay-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true })
    writeFileSync(join(root, name), body)
  }
  return root
}

function overlayFile(t, overlay) {
  const root = fixtureRoot(t, { 'overlay.json': JSON.stringify(overlay) })
  return new URL(`file://${join(root, 'overlay.json')}`)
}

function artifactDirectory(
  t,
  { runId = '1', attempt = '1', selectedShard = 1, shardCount = 1, files = {}, durations = {} }
) {
  return fixtureRoot(t, {
    'unit-assignment.json': JSON.stringify({
      runId,
      runAttempt: attempt,
      sourceSha: 'a'.repeat(40),
      selectedShard,
      shards: Array.from({ length: shardCount }, () => ({ files: Object.keys(files) }))
    }),
    'unit-report.json': JSON.stringify({
      testResults: Object.entries(durations).map(([file, milliseconds]) => ({
        name: `/home/runner/work/orca/orca/${file}`,
        startTime: 1_000,
        endTime: 1_000 + milliseconds
      }))
    })
  })
}

test('an entry is fork-added, absent from the baseline, and heavy enough to matter', () => {
  const entries = selectEntries({
    observed: new Map([
      ['src/fork-heavy.test.ts', 5_400.4],
      ['src/fork-light.test.ts', 120],
      ['src/upstream-heavy.test.ts', 9_000]
    ]),
    baselineTimings: { 'src/upstream-heavy.test.ts': 9_100 },
    forkFiles: new Set(['src/fork-heavy.test.ts', 'src/fork-light.test.ts']),
    thresholdMs: 2_000
  })
  assert.deepEqual(entries, { 'src/fork-heavy.test.ts': 5400 })
})

test('the planner merges the overlay and lets the baseline win a collision', (t) => {
  const measured = Object.keys(REAL_BASELINE.unit.timings)[0]
  const merged = mergeForkTimingOverlay(
    'unit',
    BASELINE_BYTES,
    overlayFile(t, {
      version: 1,
      unit: { timings: { 'src/fork.test.ts': 7_000, [measured]: 1 } }
    })
  )
  assert.equal(merged.timings['src/fork.test.ts'], 7_000)
  assert.equal(merged.timings[measured], REAL_BASELINE.unit.timings[measured])
  const baselineOnly = mergeForkTimingOverlay('unit', BASELINE_BYTES, new URL('file:///no/such'))
  assert.equal(baselineOnly.timings['src/fork.test.ts'], undefined)
  assert.notEqual(merged.baselineSha256, baselineOnly.baselineSha256)
})

test('the overlay weights its own suite only', (t) => {
  const merged = mergeForkTimingOverlay(
    'e2e',
    BASELINE_BYTES,
    overlayFile(t, { version: 1, unit: { timings: { 'src/fork.test.ts': 7_000 } } })
  )
  assert.equal(merged.timings['src/fork.test.ts'], undefined)
  assert.deepEqual(
    Object.keys(merged.timings).sort(),
    Object.keys(REAL_BASELINE.e2e.timings).sort()
  )
})

test('a malformed overlay stops the planner rather than scheduling without it', (t) => {
  const bodies = [
    '{',
    JSON.stringify({ version: 2, unit: { timings: {} } }),
    JSON.stringify({ version: 1 }),
    JSON.stringify({ version: 1, unit: { timings: [] } }),
    JSON.stringify({ version: 1, unit: { timings: { 'src/a.test.ts': 'slow' } } }),
    JSON.stringify({ version: 1, unit: { timings: { 'src/a.test.ts': 0 } } })
  ]
  for (const body of bodies) {
    const root = fixtureRoot(t, { 'overlay.json': body })
    assert.throws(
      () =>
        mergeForkTimingOverlay(
          'unit',
          BASELINE_BYTES,
          new URL(`file://${join(root, 'overlay.json')}`)
        ),
      /overlay|JSON/i,
      body
    )
  }
  assert.throws(() => assertOverlayShape({ version: 1, unit: { timings: null } }), /not an object/)
})

test('overlay problems stop at a shape error, and name a stale collision and a missing file', (t) => {
  const root = fixtureRoot(t, { 'src/b.test.ts': '' })
  assert.deepEqual(
    overlayProblems({ version: 3, unit: { timings: {} } }, { root, baselineTimings: {} }).length,
    1
  )
  assert.deepEqual(
    overlayProblems(
      {
        version: 1,
        estimates: { 'src/gone.test.ts': 'why' },
        unit: { timings: { 'src/b.test.ts': 5, 'src/a.test.ts': 5, 'src/upstream.test.ts': 5 } }
      },
      { root, baselineTimings: BASELINE_TIMINGS }
    ),
    [
      'unit.timings keys are not sorted',
      'src/a.test.ts: no such file',
      'src/upstream.test.ts: the baseline already measures it, so this entry is stale',
      'src/upstream.test.ts: no such file',
      'estimates.src/gone.test.ts: not an entry'
    ]
  )
})

test('the committed overlay is valid, and the planner loads it', () => {
  const overlay = JSON.parse(readFileSync(OVERLAY_PATH, 'utf8'))
  assert.deepEqual(overlayProblems(overlay, { baselineTimings: REAL_BASELINE.unit.timings }), [])
  for (const file of Object.keys(overlay.unit.timings)) {
    assert.equal(file in REAL_BASELINE.unit.timings, false, `${file} is already in the baseline`)
  }
  const merged = readTimingBaseline('unit')
  for (const [file, milliseconds] of Object.entries(overlay.unit.timings)) {
    assert.equal(merged.timings[file], milliseconds)
  }
})

test('a report path is resolved against discovery, and an unselected file is refused', (t) => {
  const directory = artifactDirectory(t, {
    files: { 'src/a.test.ts': 1, 'src/b.test.ts': 1 },
    durations: { 'src/a.test.ts': 3_000, 'src/b.test.ts': 4_000 }
  })
  const { observed, files, source } = readArtifacts([directory])
  assert.equal(observed.get('src/a.test.ts'), 3_000)
  assert.equal(observed.get('src/b.test.ts'), 4_000)
  assert.deepEqual(files, ['src/a.test.ts', 'src/b.test.ts'])
  assert.deepEqual(source, { runId: '1', attempt: '1', sha: 'a'.repeat(40) })
  const stray = artifactDirectory(t, {
    files: { 'src/a.test.ts': 1 },
    durations: { 'src/b.test.ts': 4_000 }
  })
  assert.throws(() => readArtifacts([stray]), /discovery did not select/)
})

test('an artifact set must be one run, every shard once, and no file twice', (t) => {
  const first = artifactDirectory(t, {
    shardCount: 2,
    selectedShard: 1,
    files: { 'src/a.test.ts': 1 },
    durations: { 'src/a.test.ts': 3_000 }
  })
  const second = artifactDirectory(t, {
    shardCount: 2,
    selectedShard: 2,
    files: { 'src/b.test.ts': 1 },
    durations: { 'src/b.test.ts': 4_000 }
  })
  assert.equal(readArtifacts([first, second]).observed.size, 2)
  assert.throws(() => readArtifacts([first]), /covers 1 of 2 shard/)
  assert.throws(() => readArtifacts([first, first]), /shard 1 a second time/)
  assert.throws(
    () =>
      readArtifacts([first, artifactDirectory(t, { runId: '2', shardCount: 2, selectedShard: 2 })]),
    /not from run 1 attempt 1/
  )
  assert.throws(
    () =>
      readArtifacts([
        first,
        artifactDirectory(t, { attempt: '2', shardCount: 2, selectedShard: 2 })
      ]),
    /not from run 1 attempt 1/
  )
  assert.throws(
    () =>
      readArtifacts([
        first,
        artifactDirectory(t, {
          shardCount: 2,
          selectedShard: 2,
          files: { 'src/a.test.ts': 1 },
          durations: { 'src/a.test.ts': 1 }
        })
      ]),
    /appears twice in the report set/
  )
})

test('a shard plan puts a heavy file on the lightest shard, and the spread says so', () => {
  const files = ['a', 'b', 'c', 'd', 'e', 'f']
  const observed = new Map(files.map((file) => [file, file === 'f' ? 50_000 : 10_000]))
  const spread = (loads) => Math.max(...loads) - Math.min(...loads)
  const balanced = simulateLoads({
    files,
    observed,
    timings: Object.fromEntries(observed),
    shardCount: 2
  })
  assert.equal(spread(balanced.loads), 0)
  const blind = simulateLoads({ files, observed, timings: {}, shardCount: 2 })
  assert.equal(spread(blind.loads), 40_000)
  assert.ok(summariseLoads(blind.loads).ratio > summariseLoads(balanced.loads).ratio)
})

test('the override stands in for a duration the artifacts predate', () => {
  const files = ['a', 'b']
  const observed = new Map([
    ['a', 100_000],
    ['b', 100]
  ])
  const { loads } = simulateLoads({
    files,
    observed,
    timings: {},
    shardCount: 1,
    overrides: new Map([['a', 1_000]])
  })
  assert.deepEqual(loads, [1_100])
})

test('one mode per invocation, and import needs evidence', () => {
  assert.equal(parseArgs(['import', 'dir']).mode, 'import')
  assert.equal(
    parseArgs(['import', 'dir', '--runner', 'ubuntu-24.04-arm']).runner,
    'ubuntu-24.04-arm'
  )
  assert.throws(() => parseArgs(['--check', '--simulate', 'dir']), /one mode/)
  assert.throws(() => parseArgs(['import']), /at least one artifact/)
  assert.throws(() => parseArgs(['--simulate']), /at least one artifact/)
  assert.throws(() => parseArgs(['--override', 'nope']), /PATH=MS/)
})
