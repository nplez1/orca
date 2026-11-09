// Temp-repo test for post-sync's deleted-fork-module scan and the manifest that acknowledges a deletion:
//   node --test local/sync/lib/deleted-fork-modules.test.mjs

import assert from 'node:assert/strict'
import process from 'node:process'
import test, { after } from 'node:test'
import { tempGitRepo } from './temp-git-repo.mjs'

const { dir: repo, git, commit, remove } = tempGitRepo('orca-deleted-fork-modules-')
after(remove)

commit('base', { 'src/keep.ts': 'export const keep = 1\n' })
git('checkout', '-q', '-b', 'fork')
const tip = commit('fork', {
  'src/fork-settled.ts': 'export function settledThing() {}\n',
  'src/fork-pending.ts': 'export function pendingThing() {}\n'
})
git('checkout', '-q', 'main')
const newBase = commit('upstream', { 'src/keep.ts': 'export const keep = 2\n' })
git('update-ref', 'refs/remotes/upstream/main', newBase)
git('checkout', '-q', 'fork')
git('merge', '-q', '--no-edit', 'main')
git('rm', '-q', 'src/fork-settled.ts', 'src/fork-pending.ts')
const deletions = [
  { path: 'src/fork-settled.ts', status: 'expected-deletion', reason: 'superseded' },
  { path: 'src/fork-pending.ts', status: 'pending-decision' }
]
commit('sync deletes both', {
  'local/sync/expected-deletions.json': `${JSON.stringify({ deletions }, null, 2)}\n`
})

process.chdir(repo)
const { deletedForkModules } = await import('./post-sync-checks.mjs')

test('only an expected-deletion entry acknowledges an unreferenced export; pending-decision does not', () => {
  const outcome = deletedForkModules(tip, 'fixture')
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.summary, /^1 export\(s\) of deleted fork-only module\(s\)/)
  assert.equal(outcome.details[0], '  ! src/fork-pending.ts: pendingThing')
  assert.ok(outcome.details.some((line) => line.includes('~ settledThing (function)')))
})
