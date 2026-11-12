// The overlay's contract with the shard planner: which files it may carry, that a collision with the
// baseline is stale, and that a malformed overlay stops the planner instead of silently scheduling
// with no weights at all. Fixture trees plus one pass over the real overlay.
//
//   node --test local/ci-shard-timing-overlay.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readTimingBaseline } from '../config/scripts/ci/sharding/ci-shard-assignment.mjs'
import {
  OVERLAY_PATH,
  overlayProblems,
  parseArgs,
  readArtifacts,
  selectEntries,
  simulateLoads,
  summariseLoads
} from './ci-shard-timing-overlay.mjs'
const BASELINE_TIMINGS = { 'src/upstream.test.ts': 900 }

function fixtureRoot(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orca-shard-overlay-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true })
    writeFileSync(join(root, name), body)
  }
  return root
}

function artifactDirectory(t, { runId = '1', sha = 'a'.repeat(40), files = {}, durations = {} }) {
  const root = fixtureRoot(t, {
    'unit-assignment.json': JSON.stringify({
      runId,
      sourceSha: sha,
      shards: [{ files: Object.keys(files) }]
    }),
    'unit-report.json': JSON.stringify({
      testResults: Object.entries(durations).map(([file, milliseconds]) => ({
        name: `/home/runner/work/orca/orca/${file}`,
        startTime: 1_000,
        endTime: 1_000 + milliseconds
      }))
    })
  })
  return root
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
  const realBaseline = JSON.parse(
    readFileSync(
      new URL('../config/scripts/ci/sharding/ci-shard-timings.json', import.meta.url),
      'utf8'
    )
  )
  const [measured] = Object.keys(realBaseline.unit.timings)
  const root = fixtureRoot(t, {
    'overlay.json': JSON.stringify({
      version: 1,
      unit: { timings: { 'src/fork.test.ts': 7_000, [measured]: 1 } }
    })
  })
  const merged = readTimingBaseline('unit', new URL(`file://${join(root, 'overlay.json')}`))
  assert.equal(merged.timings['src/fork.test.ts'], 7_000)
  assert.equal(merged.timings[measured], realBaseline.unit.timings[measured])
  const baselineOnly = readTimingBaseline('unit', new URL('file:///no/such/overlay.json'))
  assert.equal(baselineOnly.timings['src/fork.test.ts'], undefined)
  assert.notEqual(merged.baselineSha256, baselineOnly.baselineSha256)
})

test('a malformed overlay stops the planner rather than scheduling without it', (t) => {
  for (const body of [
    '{',
    JSON.stringify({ version: 2, unit: { timings: {} } }),
    JSON.stringify({ version: 1 })
  ]) {
    const root = fixtureRoot(t, { 'overlay.json': body })
    assert.throws(
      () => readTimingBaseline('unit', new URL(`file://${join(root, 'overlay.json')}`)),
      /overlay|JSON/i
    )
  }
})

test('overlay problems name a stale collision, an unsorted key, and a missing file', (t) => {
  const root = fixtureRoot(t, { 'src/b.test.ts': '' })
  const problems = overlayProblems(
    {
      version: 1,
      estimates: { 'src/gone.test.ts': 'why' },
      unit: { timings: { 'src/b.test.ts': 0, 'src/a.test.ts': 5, 'src/upstream.test.ts': 5 } }
    },
    { root, baselineTimings: BASELINE_TIMINGS }
  )
  assert.deepEqual(problems, [
    'unit.timings keys are not sorted',
    'src/a.test.ts: no such file',
    'src/b.test.ts: 0 is not a positive integer',
    'src/upstream.test.ts: the baseline already measures it, so this entry is stale',
    'src/upstream.test.ts: no such file',
    'estimates.src/gone.test.ts: not an entry'
  ])
})

test('the committed overlay is valid against the committed baseline', () => {
  const overlay = JSON.parse(readFileSync(OVERLAY_PATH, 'utf8'))
  const baseline = JSON.parse(
    readFileSync(
      new URL('../config/scripts/ci/sharding/ci-shard-timings.json', import.meta.url),
      'utf8'
    )
  )
  assert.deepEqual(overlayProblems(overlay, { baselineTimings: baseline.unit.timings }), [])
  for (const file of Object.keys(overlay.unit.timings)) {
    assert.equal(file in baseline.unit.timings, false, `${file} is already in the baseline`)
  }
})

test('artifacts are read by repository-relative path, summing a file seen twice', (t) => {
  const directory = artifactDirectory(t, {
    files: { 'src/a.test.ts': 1 },
    durations: { 'src/a.test.ts': 3_000, 'src/b.test.ts': 4_000 }
  })
  const { observed, files, source } = readArtifacts([directory])
  assert.equal(observed.get('src/a.test.ts'), 3_000)
  assert.equal(observed.get('src/b.test.ts'), 4_000)
  assert.deepEqual(files, ['src/a.test.ts', 'src/b.test.ts'])
  assert.equal(source.runId, '1')
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
  assert.throws(() => parseArgs(['--check', '--simulate', 'dir']), /one mode/)
  assert.throws(() => parseArgs(['import']), /at least one artifact/)
  assert.throws(() => parseArgs(['--simulate']), /at least one artifact/)
  assert.throws(() => parseArgs(['--override', 'nope']), /PATH=MS/)
})
