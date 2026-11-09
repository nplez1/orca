// Fixture tests for the upstream-deleted fork tests: which paths are the set, and when a baseline
// records them. No git, no filesystem:
//   node --test local/sync/lib/deleted-fork-tests.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildBaseline,
  compareDeletedForkTests,
  describeComparison,
  forkModifiedTests
} from './deleted-fork-tests.mjs'

const range = { base: 'base1', tip: 'tip1' }
const baselineFor = (gone, where = range) =>
  buildBaseline(gone, { ...where, accepted: 'why', note: 'n' })

test('only test files count, and only the ones gone at HEAD', () => {
  const { modified, gone } = forkModifiedTests({
    changed: [
      'src/main/a.test.ts',
      'src/main/b.ts',
      'src/main/c.spec.tsx',
      'src/main/kept.test.mjs'
    ],
    presentAtHead: new Set(['src/main/b.ts', 'src/main/kept.test.mjs'])
  })
  assert.deepEqual(modified, [
    'src/main/a.test.ts',
    'src/main/c.spec.tsx',
    'src/main/kept.test.mjs'
  ])
  assert.deepEqual(gone, ['src/main/a.test.ts', 'src/main/c.spec.tsx'])
})

test('an unrecorded loss for this range fails, and is named', () => {
  const baseline = baselineFor(['src/main/a.test.ts'])
  const comparison = compareDeletedForkTests({
    baseline,
    gone: ['src/main/a.test.ts', 'src/main/b.test.ts'],
    range
  })
  assert.equal(comparison.bound, true)
  assert.deepEqual(comparison.appeared, ['src/main/b.test.ts'])
  assert.equal(comparison.clean, false)
  assert.ok(
    describeComparison(comparison, { total: 2 }).some((line) => line.endsWith('src/main/b.test.ts'))
  )
})

test('a baseline written for another sync range records nothing', () => {
  const baseline = baselineFor(['src/main/a.test.ts'], { base: 'other-base', tip: 'other-tip' })
  const comparison = compareDeletedForkTests({
    baseline,
    gone: ['src/main/a.test.ts'],
    range
  })
  assert.equal(comparison.bound, false)
  assert.deepEqual(comparison.appeared, ['src/main/a.test.ts'])
  assert.equal(comparison.clean, false, 'the next sync has to re-earn its set in writing')
})

test('a missing baseline fails rather than passing', () => {
  const comparison = compareDeletedForkTests({
    baseline: null,
    gone: ['src/main/a.test.ts'],
    range
  })
  assert.equal(comparison.clean, false)
  assert.deepEqual(comparison.appeared, ['src/main/a.test.ts'])
})

test('a path that came back is reported as stale, not silently dropped', () => {
  const baseline = baselineFor(['src/main/a.test.ts', 'src/main/b.test.ts'])
  const comparison = compareDeletedForkTests({ baseline, gone: ['src/main/a.test.ts'], range })
  assert.equal(comparison.clean, true)
  assert.deepEqual(comparison.stale, ['src/main/b.test.ts'])
})

test('the baseline records the range it was measured against', () => {
  const baseline = baselineFor(['src/main/a.test.ts'])
  assert.equal(baseline.base, 'base1')
  assert.equal(baseline.tip, 'tip1')
  assert.equal(baseline.total, 1)
  assert.deepEqual(baseline.files, { 'src/main/a.test.ts': true })
})

test('a gone path with a same-named file elsewhere is reported apart from a true deletion', () => {
  const { gone, moved } = forkModifiedTests({
    changed: ['config/scripts/a.test.mjs', 'src/main/b.test.ts', 'src/main/c.test.ts'],
    presentAtHead: new Set(['config/scripts/deep/a.test.mjs', 'src/main/c.test.ts'])
  })
  assert.deepEqual(gone, ['config/scripts/a.test.mjs', 'src/main/b.test.ts'])
  // `a.test.mjs` moved into a subdirectory; `b.test.ts` has no same-named survivor.
  assert.deepEqual(moved, ['config/scripts/a.test.mjs'])
})
