// Temp-repo test for the range every post-sync check is built from: which commits this sync is made of,
// and whether the recorded tip and base belong to the merge being judged.
//   node --test local/sync/lib/sync-range.test.mjs

import assert from 'node:assert/strict'
import process from 'node:process'
import test, { after } from 'node:test'
import { tempGitRepo } from './temp-git-repo.mjs'

const { dir: repo, git, commit, remove } = tempGitRepo('orca-sync-range-')
after(remove)
process.chdir(repo)
const { BACKUP_REF, mergePair, pinnedUpstreamBase, resolvePreSyncTip } =
  await import('./sync-range.mjs')
const { clearSyncState, writeSyncState } = await import('./run.mjs')

commit('base', { 'src/a.ts': 'export const a = 1\n' })
git('checkout', '-q', '-b', 'fork')
const oldTip = commit('fork work', { 'src/a.ts': 'export const a = 2\n' })
git('checkout', '-q', 'main')
const newBase = commit('upstream work', { 'src/b.ts': 'export const b = 1\n' })
git('update-ref', 'refs/remotes/upstream/main', newBase)
git('checkout', '-q', 'fork')
git('merge', '-q', '--no-edit', 'main')
const merge = git('rev-parse', 'HEAD')
const parents = git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1)

test('a merge names its own two sides', () => {
  assert.deepEqual(mergePair(), { tip: parents[0], base: parents[1], midMerge: false })
  assert.equal(merge, git('rev-parse', 'HEAD'))
})

test('the recorded state file is accepted when it describes this merge', () => {
  writeSyncState({ tool: 'fixture', oldTip: parents[0], newBase: parents[1] })
  assert.deepEqual(resolvePreSyncTip(), {
    tip: parents[0],
    source: `git-dir state file (${git('rev-parse', '--absolute-git-dir')}/orca-pre-sync-state.json)`,
    problem: null
  })
  const pinned = pinnedUpstreamBase(parents[0], 'fixture')
  assert.equal(pinned.base, parents[1])
})

test('a state file left over from another sync is refused, not trusted', () => {
  // The real failure: the state file names a commit from a different sync, and every range check below
  // then scans the wrong range and reports a pass.
  writeSyncState({ tool: 'fixture', oldTip: newBase, newBase: parents[1] })
  const tip = resolvePreSyncTip()
  assert.equal(tip.tip, null)
  assert.match(tip.problem, /does not belong to this merge/)

  writeSyncState({ tool: 'fixture', oldTip: parents[0], newBase: oldTip })
  const base = pinnedUpstreamBase(parents[0], 'fixture')
  assert.equal(base.base, null)
  assert.match(base.problem, /does not belong to this merge/)
})

test('a state file whose refs do not resolve falls through to the backup ref', () => {
  git('update-ref', `refs/heads/${BACKUP_REF}`, parents[0])
  writeSyncState({ tool: 'fixture', oldTip: 'deadbeefdeadbeef', newBase: 'deadbeefdeadbeef' })
  assert.equal(resolvePreSyncTip().tip, parents[0])
})

test('a stale backup ref is refused too', () => {
  git('update-ref', `refs/heads/${BACKUP_REF}`, oldTip)
  // The stale state file is gone, so the backup ref is the only record left — and it is right here.
  writeSyncState({ tool: 'fixture' })
  assert.deepEqual(resolvePreSyncTip(), { tip: oldTip, source: `ref ${BACKUP_REF}`, problem: null })

  git('update-ref', `refs/heads/${BACKUP_REF}`, newBase)
  const stale = resolvePreSyncTip()
  assert.equal(stale.tip, null)
  assert.match(stale.problem, /not at HEAD's first parent/)
})

test('with no state file at all the merge itself names the base', () => {
  git('update-ref', `refs/heads/${BACKUP_REF}`, parents[0])
  writeSyncState({ tool: 'fixture' })
  const pinned = pinnedUpstreamBase(parents[0], `ref ${BACKUP_REF}`)
  assert.equal(pinned.base, parents[1])
  assert.match(pinned.source, /HEAD\^2/)
})

test('mid-merge, HEAD is the old tip and MERGE_HEAD is the new base', () => {
  git('checkout', '-q', '-b', 'mid-merge', parents[0])
  // `--no-commit` leaves MERGE_HEAD behind, which is the state post-sync itself runs in.
  let conflicted = false
  try {
    git('merge', '--no-commit', '--no-ff', parents[1])
  } catch {
    conflicted = true
  }
  const pair = mergePair()
  assert.notEqual(pair, null)
  assert.equal(pair.midMerge, true)
  assert.equal(pair.tip, git('rev-parse', 'HEAD'))
  assert.equal(pair.base, git('rev-parse', 'MERGE_HEAD'))
  // A state file describing this merge is accepted; one describing another is not.
  writeSyncState({ tool: 'fixture', oldTip: pair.tip, newBase: pair.base })
  assert.equal(resolvePreSyncTip().tip, pair.tip)
  writeSyncState({ tool: 'fixture', oldTip: newBase, newBase: pair.base })
  assert.match(resolvePreSyncTip().problem, /does not belong to this merge/)
  if (conflicted) {
    git('merge', '--abort')
  }
  git('checkout', '-q', 'fork')
  git('branch', '-q', '-D', 'mid-merge')
})

test('a tip outside HEAD history is refused even when HEAD is not a merge', () => {
  // A fixup commit on top of the merge: the parent comparison has nothing to compare against, and the
  // ancestor check is what still catches a state file from another sync.
  const root = git('rev-parse', `${parents[0]}~1`)
  git('checkout', '-q', '-b', 'elsewhere', root)
  const unrelated = commit('on another line', { 'src/other.ts': 'export const other = 1\n' })
  git('checkout', '-q', '-b', 'with-fixup', parents[0])
  writeSyncState({ tool: 'fixture', oldTip: unrelated, newBase: parents[1] })
  assert.match(resolvePreSyncTip().problem, /not in HEAD's history/)
  assert.match(pinnedUpstreamBase(null, null).problem, /not in HEAD's history/)
  git('checkout', '-q', 'fork')
  git('branch', '-q', '-D', 'with-fixup')
  git('branch', '-q', '-D', 'elsewhere')
})

test('clearSyncState drops the file and reports what it removed', () => {
  writeSyncState({ tool: 'fixture', oldTip: parents[0], newBase: parents[1] })
  const removed = clearSyncState()
  assert.match(removed, /orca-pre-sync-state\.json$/)
  assert.equal(clearSyncState(), null)
})
