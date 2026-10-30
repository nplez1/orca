// Fixture tests for the post-sync row table: what is wired, and that a tip from another sync fails every
// row that reads a range instead of scanning it. No git, no filesystem, no spawned checks:
//   node --test local/sync/lib/post-sync-rows.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'
import { postSyncRowIds, postSyncRows } from './post-sync-rows.mjs'

const rows = (extra = {}) =>
  postSyncRows({ tip: null, source: null, problem: null, options: {}, ...extra })
const row = (id, extra) => rows(extra).find(([candidate]) => candidate === id)

test('the range checks the audit named are rows, not a tool somebody has to remember', () => {
  const ids = postSyncRowIds({})
  for (const id of [
    'lost-content',
    'deleted-fork-modules',
    'fork-symbol-survival',
    'dangling-references',
    'repo-lint',
    'typecheck'
  ]) {
    assert.ok(ids.includes(id), id)
  }
  // forkSymbolSurvival used to be a separate command the runbook never mentioned.
  assert.equal(ids.filter((id) => id === 'fork-symbol-survival').length, 1)
})

test('every row is [id, title, look, run] with a callable check', () => {
  for (const entry of rows()) {
    assert.equal(entry.length, 4)
    const [id, title, look, run] = entry
    assert.match(id, /^[a-z][a-z-]+$/)
    assert.ok(title.length > 0)
    assert.ok(look.length > 0)
    assert.equal(typeof run, 'function', id)
  }
})

test('a tip that belongs to another sync fails every row that would read the range', () => {
  const problem = 'the state file names commit deadbeef00, which is not in HEAD\u2019s history'
  for (const id of [
    'lost-content',
    'deleted-fork-modules',
    'fork-symbol-survival',
    'dangling-references'
  ]) {
    const outcome = row(id, { tip: null, problem })[3]()
    assert.equal(outcome.status, 'failed', id)
    assert.match(outcome.summary, /does not belong to this sync/, id)
  }
})

test('no tip leaves those rows unavailable, which is not a pass', () => {
  for (const id of [
    'lost-content',
    'deleted-fork-modules',
    'fork-symbol-survival',
    'dangling-references'
  ]) {
    const outcome = row(id, { tip: null })[3]()
    assert.equal(outcome.status, 'unavailable', id)
  }
})
