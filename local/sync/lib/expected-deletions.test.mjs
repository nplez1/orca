// Fixture tests for the deletion-manifest reader. No git, no filesystem:
//   node --test local/sync/lib/expected-deletions.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EXPECTED_DELETION_STATUSES,
  boundDeletion,
  deletionFor,
  parseExpectedDeletions,
  parseExpectedSymbols,
  pendingDeletionPaths,
  prunableDeletions,
  readDeletionManifest,
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

test('the symbols half reads path + symbol pairs and defaults to pending, never to settled', () => {
  const { entries, note } = parseExpectedSymbols(
    JSON.stringify({
      deletions: [{ path: 'src/file-entry.ts' }],
      symbols: [
        {
          path: 'src/a.ts',
          symbol: 'S.fork',
          status: 'expected-deletion',
          supersededBy: 'src/b.ts'
        },
        { path: 'src/a.ts', symbol: 'later' },
        { path: 'src/a.ts', symbol: 'later' },
        { path: 'src/a.ts' },
        { path: 'src/a.ts', symbol: 'odd', status: 'maybe' }
      ]
    })
  )
  assert.deepEqual(
    entries.map((entry) => [entry.symbol, entry.status]),
    [
      ['S.fork', 'expected-deletion'],
      ['later', 'pending-decision'],
      ['later', 'pending-decision'],
      ['odd', 'maybe']
    ]
  )
  assert.match(note, /listed twice/)
  assert.match(note, /needs both path and symbol/)
  assert.match(note, /unknown status "maybe"/)
  assert.deepEqual(parseExpectedSymbols(JSON.stringify({ deletions: [] })), {
    entries: [],
    note: null
  })
})

const BLOB_A = 'a'.repeat(40)
const BLOB_B = 'b'.repeat(40)

test('an entry records the upstream blob it was judged against', () => {
  const { entries, note } = parseExpectedDeletions(
    manifest({ path: 'src/gone.ts', commit: 'abc1234567', upstreamBlob: BLOB_A })
  )
  assert.equal(note, null)
  assert.equal(entries[0].upstreamBlob, BLOB_A)
})

test('an upstreamBlob that is not a blob SHA is reported, not trusted', () => {
  const { entries, note } = parseExpectedDeletions(
    manifest({ path: 'src/gone.ts', upstreamBlob: 'abc1234567' })
  )
  assert.equal(entries[0].upstreamBlob, 'abc1234567')
  assert.match(note, /not a blob SHA/)
})

test('a decision holds only for the blob it was judged against', () => {
  const entry = { path: 'src/gone.ts', status: 'expected-deletion', upstreamBlob: BLOB_A }
  assert.deepEqual(boundDeletion(entry, BLOB_A), { entry, rebound: false })
  const changed = boundDeletion(entry, BLOB_B)
  assert.equal(changed.rebound, true)
  assert.equal(changed.entry.status, 'pending-decision')
  // The recorded reason is the reviewer's, so a rebind does not rewrite it.
  assert.equal(changed.entry.upstreamBlob, BLOB_A)
})

test('an entry with no blob, or a blob nobody can read, keeps its status', () => {
  const unbound = { path: 'src/gone.ts', status: 'expected-deletion', upstreamBlob: null }
  assert.deepEqual(boundDeletion(unbound, BLOB_B), { entry: unbound, rebound: false })
  const bound = { path: 'src/gone.ts', status: 'expected-deletion', upstreamBlob: BLOB_A }
  assert.deepEqual(boundDeletion(bound, null), { entry: bound, rebound: false })
  assert.equal(boundDeletion(null, BLOB_A).rebound, false)
})

test('an entry neither side has any more is prunable, and a live one is not', () => {
  const entries = [
    { path: 'src/prune-me.ts', status: 'expected-deletion' },
    { path: 'src/upstream-still-has-it.ts', status: 'expected-deletion' },
    { path: 'src/head-still-has-it.ts', status: 'restore' }
  ]
  assert.deepEqual(
    prunableDeletions(entries, {
      presentAtHead: new Set(['src/head-still-has-it.ts']),
      presentUpstream: new Set(['src/upstream-still-has-it.ts'])
    }),
    ['src/prune-me.ts']
  )
})

test('the reader applies the binding, names what it reopened, and flags prunable entries', () => {
  const text = JSON.stringify({
    deletions: [
      { path: 'src/held.ts', status: 'expected-deletion', upstreamBlob: BLOB_A },
      { path: 'src/repurposed.ts', status: 'expected-deletion', upstreamBlob: BLOB_A },
      { path: 'src/prunable.ts', status: 'expected-deletion' }
    ]
  })
  const manifest = readDeletionManifest({
    text,
    presentAtHead: new Set([]),
    presentUpstream: new Set(['src/held.ts', 'src/repurposed.ts']),
    upstreamBlobOf: (path) => (path === 'src/held.ts' ? BLOB_A : BLOB_B)
  })
  assert.deepEqual(
    manifest.entries.map((entry) => [entry.path, entry.status]),
    [
      ['src/held.ts', 'expected-deletion'],
      ['src/repurposed.ts', 'pending-decision'],
      ['src/prunable.ts', 'expected-deletion']
    ]
  )
  assert.deepEqual(manifest.prunable, ['src/prunable.ts'])
  assert.deepEqual(manifest.rebound.length, 1)
  assert.match(manifest.note, /src\/repurposed\.ts \(judged a{10}\)/)
  assert.match(manifest.note, /can be pruned: src\/prunable\.ts/)
  // The parser had nothing to complain about; only `failure` fails a scan.
  assert.equal(manifest.failure, null)
})

test('a missing manifest is a note, and an unreadable one is a failure', () => {
  const missing = readDeletionManifest({ text: null, presentAtHead: new Set() })
  assert.deepEqual(missing.entries, [])
  assert.match(missing.note, /no deletion manifest/)
  assert.equal(missing.failure, null)

  const broken = readDeletionManifest({ text: '{ not json', presentAtHead: new Set() })
  assert.match(broken.failure, /not valid JSON/)
})
