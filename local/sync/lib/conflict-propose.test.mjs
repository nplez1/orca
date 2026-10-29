// Fixture tests for the proposal rules. No git, no filesystem:
//   node --test local/sync/lib/conflict-propose.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyableProposals,
  forkDeleted,
  forkHasOwnHunks,
  proposeAll,
  proposeResolution
} from './conflict-propose.mjs'

const settledDeletion = (status = 'expected-deletion') => ({
  path: 'src/old.ts',
  status,
  commit: 'abc1234567',
  reason: 'superseded'
})

const ledgerEntry = (action, note = '') => ({
  title: 'Some subsystem',
  resolution: { action, verb: action, note }
})

// `forkUntouched`: ours == base on every hunk, so the fork changed nothing here.
const forkUntouched = [{ base: ['const x = 1'], ours: ['const x = 1'], theirs: ['const x = 2'] }]
const forkRewrote = [{ base: ['const x = 1'], ours: ['const x = fork()'], theirs: ['const x = 2'] }]

test('a settled deletion is applied as a removal', () => {
  const proposal = proposeResolution({
    path: 'src/old.ts',
    status: 'DU',
    class: 'modify/delete',
    expectedDeletion: settledDeletion(),
    ledger: []
  })
  assert.equal(proposal.action, 'delete')
  assert.deepEqual(proposal.git, [['rm', '-f', '--', 'src/old.ts']])
  assert.match(proposal.provenance, /expected-deletions/)
})

test('a settled deletion the fork did not make is not applied', () => {
  // `UD` is deleted by THEM: the fork still has its file, so `git rm -f` would throw away fork work.
  assert.equal(
    proposeResolution({
      path: 'src/old.ts',
      status: 'UD',
      class: 'modify/delete',
      expectedDeletion: settledDeletion(),
      ledger: []
    }),
    null
  )
})

test('a manifest that says restore takes the other side', () => {
  const proposal = proposeResolution({
    path: 'src/old.ts',
    class: 'modify/delete',
    expectedDeletion: settledDeletion('restore'),
    ledger: []
  })
  assert.equal(proposal.action, 'take-theirs')
  assert.deepEqual(proposal.git.at(-1), ['add', '--', 'src/old.ts'])
})

test('a pending decision proposes nothing at all', () => {
  assert.equal(
    proposeResolution({
      path: 'src/old.ts',
      class: 'modify/delete',
      expectedDeletion: settledDeletion('pending-decision'),
      ledger: []
    }),
    null
  )
})

test('the manifest outranks the ledger for a modify/delete', () => {
  const proposal = proposeResolution({
    path: 'src/old.ts',
    status: 'DU',
    class: 'modify/delete',
    expectedDeletion: settledDeletion(),
    ledger: [ledgerEntry('take-theirs')]
  })
  assert.equal(proposal.action, 'delete')
})

test('a pending decision is not answered by a ledger verb either', () => {
  // `fork-symbols.mjs` promises pending-decision silences nothing; before this the verb applied anyway.
  assert.equal(
    proposeResolution({
      path: 'src/old.ts',
      status: 'DU',
      class: 'modify/delete',
      expectedDeletion: settledDeletion('pending-decision'),
      ledger: [ledgerEntry('delete')]
    }),
    null
  )
})

test('a ledger delete is refused on a both-modified file', () => {
  // An upstream file the fork still owns must never be `git rm -f`'d, whatever the ledger says.
  for (const file of [
    { path: 'src/main/providers/ssh-filesystem-a.ts', status: 'UU', class: 'both-rewrote' },
    { path: 'src/main/providers/ssh-filesystem-b.ts', status: 'UD', class: 'modify/delete' }
  ]) {
    assert.equal(
      proposeResolution({
        ...file,
        expectedDeletion: null,
        ledger: [ledgerEntry('delete', 'fork removed it')]
      }),
      null,
      file.status
    )
  }
})

test('a ledger delete is applied where the fork is the side that deleted', () => {
  const proposal = proposeResolution({
    path: 'src/relay/old.ts',
    status: 'DU',
    class: 'modify/delete',
    expectedDeletion: null,
    ledger: [ledgerEntry('delete', 'fork removed it')]
  })
  assert.equal(proposal.action, 'delete')
})

test('a ledger verb applies to a conflict the manifest does not cover', () => {
  const ours = proposeResolution({
    path: 'src/x.ts',
    status: 'UU',
    class: 'both-rewrote',
    expectedDeletion: null,
    ledger: [ledgerEntry('keep-ours', 'the fork owns this seam')]
  })
  assert.equal(ours.action, 'keep-ours')
  assert.deepEqual(ours.git[0], ['checkout', '--ours', '--', 'src/x.ts'])
  assert.equal(ours.reason, 'the fork owns this seam')

  const theirs = proposeResolution({
    path: 'src/y.ts',
    status: 'UU',
    class: 'union',
    expectedDeletion: null,
    hunks: forkUntouched,
    ledger: [ledgerEntry('take-theirs')]
  })
  assert.equal(theirs.action, 'take-theirs')
})

test('take-theirs is refused where the fork has hunks of its own', () => {
  assert.equal(
    proposeResolution({
      path: 'src/z.ts',
      status: 'UU',
      class: 'both-rewrote',
      expectedDeletion: null,
      hunks: forkRewrote,
      ledger: [ledgerEntry('take-theirs')]
    }),
    null
  )
})

test('an annotation with no hunks proves nothing about the fork, so take-theirs is refused', () => {
  assert.equal(
    proposeResolution({
      path: 'src/z.ts',
      status: 'UU',
      class: 'no-markers',
      expectedDeletion: null,
      ledger: [ledgerEntry('take-theirs')]
    }),
    null
  )
})

test('forkHasOwnHunks and forkDeleted say what they cannot see', () => {
  assert.equal(forkHasOwnHunks({}), null)
  assert.equal(forkHasOwnHunks({ hunks: forkUntouched }), false)
  assert.equal(forkHasOwnHunks({ hunks: forkRewrote }), true)
  // No `|||||||` section: an empty base would read any hunk as fork-owned, so the answer is unknown.
  assert.equal(forkHasOwnHunks({ hunks: [{ ours: [], base: [], basePresent: false }] }), null)
  assert.equal(forkDeleted({}), null)
  assert.equal(forkDeleted({ sides: { base: true, ours: false, theirs: true } }), true)
  assert.equal(forkDeleted({ status: 'DU' }), true)
  assert.equal(forkDeleted({ status: 'UD' }), false)
  // A rebase swaps the sides: `UD` is the fork's deletion, `DU` is upstream's.
  assert.equal(forkDeleted({ status: 'UD' }, { rebase: true }), true)
  assert.equal(forkDeleted({ status: 'DU' }, { rebase: true }), false)
  assert.equal(
    forkDeleted({ sides: { base: true, ours: true, theirs: false } }, { rebase: true }),
    true
  )
})

test('manual, rerere and an unknown verb are not answers to apply', () => {
  for (const action of ['manual', 'rerere', 'delete-later']) {
    assert.equal(
      proposeResolution({
        path: 'src/z.ts',
        class: 'both-rewrote',
        expectedDeletion: null,
        ledger: [ledgerEntry(action)]
      }),
      null
    )
  }
})

test('a ledger section with no Resolution proposes nothing', () => {
  assert.equal(
    proposeResolution({
      path: 'src/z.ts',
      class: 'union',
      expectedDeletion: null,
      ledger: [{ title: 'Prose only', resolution: null }]
    }),
    null
  )
})

test('proposeAll drops the undecided ones instead of emitting nulls', () => {
  const proposals = proposeAll([
    {
      path: 'src/old.ts',
      status: 'DU',
      class: 'modify/delete',
      expectedDeletion: settledDeletion(),
      ledger: []
    },
    { path: 'src/undecided.ts', class: 'both-rewrote', expectedDeletion: null, ledger: [] }
  ])
  assert.equal(proposals.length, 1)
  assert.equal(proposals[0].path, 'src/old.ts')
  assert.equal(applyableProposals(proposals).length, 1)
})
