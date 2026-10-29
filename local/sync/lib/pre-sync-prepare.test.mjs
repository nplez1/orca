// Temp-repo test for `--prepare`'s re-point: a stale backup is archived and moved, not left as a
// permanent failure, and a tag that has already been published is never moved.
//   node --test local/sync/lib/pre-sync-prepare.test.mjs

import assert from 'node:assert/strict'
import process from 'node:process'
import test, { after } from 'node:test'
import { tempGitRepo } from './temp-git-repo.mjs'

const { dir: repo, git, commit, remove } = tempGitRepo('orca-prepare-repoint-')
after(remove)

const first = commit('first', { 'src/a.ts': 'export const a = 1\n' })
const second = commit('second', { 'src/a.ts': 'export const a = 2\n' })
git('update-ref', 'refs/remotes/upstream/main', second)
git('update-ref', 'refs/heads/nplez1/main', second)
// A backup left pointing at the previous sync's tip: the case the runbook calls stale.
git('update-ref', 'refs/heads/backup/nplez1-main-pre-sync', first)

process.chdir(repo)
const { BACKUP_REF, prepare } = await import('./pre-sync-checks.mjs')

const outcome = prepare(
  { shas: { forkRef: 'refs/heads/nplez1/main', oldBase: first, oldTip: second, newBase: second } },
  0
)

test('a stale backup is archived under its own tag and re-pointed at the pre-sync tip', () => {
  assert.deepEqual(outcome.failures, [])
  assert.equal(git('rev-parse', `refs/heads/${BACKUP_REF}`), second)
  assert.equal(git('rev-parse', `refs/tags/archive/pre-sync-backup-${first.slice(0, 10)}`), first)
  assert.ok(outcome.messages.some((line) => /re-pointed .*\(was/.test(line)))
})

test('the state file records this sync and a rerun does not move the ref again', () => {
  assert.equal(outcome.state.oldTip, second)
  const rerun = prepare(
    {
      shas: { forkRef: 'refs/heads/nplez1/main', oldBase: first, oldTip: second, newBase: second }
    },
    0
  )
  assert.deepEqual(rerun.failures, [])
  assert.equal(git('rev-parse', `refs/heads/${BACKUP_REF}`), second)
  assert.ok(rerun.messages.some((line) => /left exactly as it is/.test(line)))
})

test('a stale archive TAG is reported as a failure instead of being moved', () => {
  git('tag', '-d', `archive/pre-sync-${second.slice(0, 10)}`)
  git('tag', `archive/pre-sync-${second.slice(0, 10)}`, first)
  const tagged = prepare(
    {
      shas: { forkRef: 'refs/heads/nplez1/main', oldBase: first, oldTip: second, newBase: second }
    },
    0
  )
  // The backup already points at the tip, so only the tag is wrong — and a published tag must not move.
  assert.equal(git('rev-parse', `refs/tags/archive/pre-sync-${second.slice(0, 10)}`), first)
  assert.ok(tagged.failures.some((line) => /tag archive\/pre-sync-.* is stale/.test(line)))
})
