// Temp-repo test for the post-sync driver's --only mode: a partial run saves its report beside the state
// file and leaves the state file alone, because only a full clean run may retire it.
//   node --test local/sync/lib/post-sync-partial.test.mjs

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { tempGitRepo } from './temp-git-repo.mjs'

const driver = path.join(import.meta.dirname, '..', 'post-sync.mjs')
const { dir, git, commit, remove } = tempGitRepo('orca-post-sync-partial-')
after(remove)
commit('base', { 'src/a.ts': 'export const a = 1\n' })
const gitDir = git('rev-parse', '--absolute-git-dir')
const postSync = (...args) => spawnSync('node', [driver, ...args], { cwd: dir, encoding: 'utf8' })

test('a passing --only run keeps the state file and saves a report that says it was partial', () => {
  const state = path.join(gitDir, 'orca-pre-sync-state.json')
  writeFileSync(state, `${JSON.stringify({ oldTip: git('rev-parse', 'HEAD') })}\n`)
  const result = postSync('--only', 'conflict-markers', '--json')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).result, 'partial-pass')
  assert.ok(existsSync(state), 'a partial run must not retire the state file')
  const saved = readFileSync(path.join(gitDir, 'orca-sync', 'post-sync-partial-last.txt'), 'utf8')
  assert.match(saved, /result: PARTIAL PASS \(--only conflict-markers: 1 of \d+ check\(s\)/)
  assert.match(result.stderr, /report saved to .*post-sync-partial-last\.txt/)
})

test('an unknown --only id is a usage error that names the valid ids', () => {
  const result = postSync('--only', 'conflict-markers,typo')
  assert.equal(result.status, 2)
  assert.match(result.stderr, /--only names no check typo — valid ids: conflict-markers, /)
})
