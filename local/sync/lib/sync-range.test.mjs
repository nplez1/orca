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
const { writeSyncState } = await import('./run.mjs')

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
