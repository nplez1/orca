// Fixture tests for the shared report verdict: what "N/A" is worth, and what a waiver records.
//   node --test local/sync/lib/report.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'
import { Report, STATUS } from './run.mjs'

const report = (...outcomes) => {
  const built = new Report('fixture')
  for (const [id, status] of outcomes) {
    built.add(id, status, id, `${id} summary`)
  }
  return built
}

test('a check that could not run is not a pass', () => {
  const built = report(['a', STATUS.passed], ['b', STATUS.unavailable])
  assert.equal(built.result(), 'fail')
  assert.deepEqual(
    built.unwaived.map((check) => check.id),
    ['b']
  )
  assert.match(built.render(), /result: FAIL — 1 check\(s\) could not run: b/)
})

test('a waiver records the reason and lets the run pass', () => {
  const built = report(['a', STATUS.passed], ['b', STATUS.unavailable])
  built.waive('b', 'upstream is not fetched in this worktree')
  assert.equal(built.result(), 'pass')
  assert.deepEqual(built.unwaived, [])
  const rendered = built.render()
  assert.match(rendered, /\[N\/A\] b — b summary \(waived: upstream is not fetched/)
  assert.match(rendered, /WAIVED: b — upstream is not fetched/)
  assert.match(rendered, /result: PASS — no hard gate failed, 1 waived/)
  assert.deepEqual(built.toJSON().waived, [
    { id: 'b', reason: 'upstream is not fetched in this worktree' }
  ])
})

test('a skipped check is an explicit operator choice, so it does not fail the run', () => {
  const built = report(['a', STATUS.passed], ['b', STATUS.skipped])
  assert.equal(built.result(), 'pass')
  assert.match(built.render(), /NOT RUN: b \(skipped\)/)
})

test('a failure is a failure whether or not anything was waived', () => {
  const built = report(['a', STATUS.failed], ['b', STATUS.unavailable])
  built.waive('b', 'reason')
  assert.equal(built.result(), 'fail')
  assert.equal(built.failures.length, 1)
  assert.match(built.render(), /result: FAIL — 1 of 2 check\(s\) failed/)
})

test('a waiver naming no check is refused', () => {
  const built = report(['a', STATUS.passed])
  assert.throws(() => built.waive('typo', 'reason'), /no check typo to waive/)
})
