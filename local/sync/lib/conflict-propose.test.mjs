// Fixture tests for the proposal rules. No git, no filesystem:
//   node --test local/sync/lib/conflict-propose.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'
import { applyableProposals, proposeAll, proposeResolution } from './conflict-propose.mjs'

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

test('a settled deletion is applied as a removal', () => {
  const proposal = proposeResolution({
    path: 'src/old.ts',
    class: 'modify/delete',
    expectedDeletion: settledDeletion(),
    ledger: []
  })
  assert.equal(proposal.action, 'delete')
  assert.deepEqual(proposal.git, [['rm', '-f', '--', 'src/old.ts']])
  assert.match(proposal.provenance, /expected-deletions/)
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
    class: 'modify/delete',
    expectedDeletion: settledDeletion(),
    ledger: [ledgerEntry('take-theirs')]
  })
  assert.equal(proposal.action, 'delete')
})

test('a ledger verb applies to a conflict the manifest does not cover', () => {
  const ours = proposeResolution({
    path: 'src/x.ts',
    class: 'both-rewrote',
    expectedDeletion: null,
    ledger: [ledgerEntry('keep-ours', 'the fork owns this seam')]
  })
  assert.equal(ours.action, 'keep-ours')
  assert.deepEqual(ours.git[0], ['checkout', '--ours', '--', 'src/x.ts'])
  assert.equal(ours.reason, 'the fork owns this seam')

  const theirs = proposeResolution({
    path: 'src/y.ts',
    class: 'union',
    expectedDeletion: null,
    ledger: [ledgerEntry('take-theirs')]
  })
  assert.equal(theirs.action, 'take-theirs')
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
