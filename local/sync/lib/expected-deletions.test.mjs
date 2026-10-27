// Fixture tests for the deletion-manifest reader. No git, no filesystem:
//   node --test local/sync/lib/expected-deletions.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EXPECTED_DELETION_STATUSES,
  deletionFor,
  parseExpectedDeletions,
  pendingDeletionPaths,
  staleDeletions
} from './expected-deletions.mjs'

const manifest = (...deletions) => JSON.stringify({ deletions })

test('a malformed manifest is a note, never a throw', () => {
  const parsed = parseExpectedDeletions('{ not json')
  assert.deepEqual(parsed.entries, [])
  assert.match(parsed.note, /not valid JSON/)
})

test('an entry without a status is a settled deletion', () => {
  const { entries, note } = parseExpectedDeletions(manifest({ path: 'src/gone.ts' }))
  assert.equal(note, null)
  assert.equal(entries[0].status, 'expected-deletion')
  assert.equal(entries[0].class, 'unclassified')
})

test('an unknown status is reported instead of being trusted', () => {
  const { note } = parseExpectedDeletions(manifest({ path: 'src/a.ts', status: 'probably-fine' }))
  assert.match(note, /unknown status "probably-fine"/)
  assert.ok(!EXPECTED_DELETION_STATUSES.includes('probably-fine'))
})

test('a path listed twice is reported, because two entries answer one conflict differently', () => {
  const { note } = parseExpectedDeletions(manifest({ path: 'src/a.ts' }, { path: 'src/a.ts' }))
  assert.match(note, /listed 2 times/)
})

test('lookup is by exact path', () => {
  const { entries } = parseExpectedDeletions(
    manifest({ path: 'src/a.ts', reason: 'because' }, { path: 'src/b.ts' })
  )
  assert.equal(deletionFor(entries, 'src/a.ts').reason, 'because')
  assert.equal(deletionFor(entries, 'src/nope.ts'), null)
})

test('pending decisions are named only for paths that actually conflict', () => {
  const { entries } = parseExpectedDeletions(
    manifest(
      { path: 'src/settled.ts', status: 'expected-deletion' },
      { path: 'src/undecided.ts', status: 'pending-decision' },
      { path: 'src/undecided-and-quiet.ts', status: 'pending-decision' }
    )
  )
  assert.deepEqual(pendingDeletionPaths(entries, ['src/undecided.ts', 'src/settled.ts']), [
    'src/undecided.ts'
  ])
})

test('a manifest that calls a present file deleted is stale', () => {
  const { entries } = parseExpectedDeletions(
    manifest({ path: 'src/restored.ts' }, { path: 'src/restored-on-purpose.ts', status: 'restore' })
  )
  assert.deepEqual(
    staleDeletions(entries, new Set(['src/restored.ts', 'src/restored-on-purpose.ts'])),
    ['src/restored.ts']
  )
})
