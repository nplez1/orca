// Temp-repo tests for the git half of the fork-symbol survival check:
//   node --test local/sync/lib/fork-symbol-check.test.mjs

import assert from 'node:assert/strict'
import process from 'node:process'
import test, { after } from 'node:test'
import { tempGitRepo } from './temp-git-repo.mjs'

const { dir: repo, git, commit, remove } = tempGitRepo('orca-fork-symbol-check-')
after(remove)

const oldBase = commit('base', {
  'local/sync/expected-deletions.json': '{ "deletions": [], "symbols": [] }\n',
  'src/a.ts': 'export const config = { up: 1 }\n',
  'src/upstream.ts': 'export const enabled = true\n'
})
git('checkout', '-q', '-b', 'fork')
const tip = commit('fork', {
  'src/a.ts': [
    'export const config = { up: 1, enabled: true }',
    '// forkThing keeps the fork behaviour',
    'export function forkThing() {}',
    ''
  ].join('\n'),
  'src/a.test.ts': "import { forkThing } from './a'\nforkThing()\n"
})
git('checkout', '-q', 'main')
const newBase = commit('upstream', {
  'src/upstream.ts': 'export const enabled = true\nexport const more = 2\n'
})
git('checkout', '-q', 'fork')
git('merge', '-q', '--no-edit', 'main')
const merged = commit('resolution drops the fork names', {
  'src/a.ts': 'export const config = { up: 1 }\n// forkThing keeps the fork behaviour\n'
})
const relocatedOnly = commit('the fork function comes back', {
  'src/a.ts':
    'export const config = { up: 1 }\n// forkThing keeps the fork behaviour\nexport function forkThing() {}\n'
})

process.chdir(repo)
const { scanForkSymbols } = await import('./fork-symbol-check.mjs')

test('a merged ref that is still the pre-sync tip fails instead of comparing the tip with itself', () => {
  const outcome = scanForkSymbols({ oldBase, tip, newBase, merged: tip })
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.summary, /does not contain the new base .* not the merge result/)
  assert.equal(scanForkSymbols({ oldBase, tip, newBase, merged: newBase }).status, 'failed')
})

test('fork-added tests and comments are not a home; an upstream line is, and it is not a pass', () => {
  const outcome = scanForkSymbols({ oldBase, tip, newBase, merged })
  assert.deepEqual(
    Object.fromEntries(outcome.results.map((result) => [result.name, result.verdict])),
    { forkThing: 'lost', 'config.enabled': 'relocated' }
  )
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.summary, /1 fork-added name\(s\) .*; 1 relocated name\(s\) to review/)
  assert.deepEqual(
    outcome.manifestEntries.map((entry) => entry.symbol),
    ['forkThing', 'config.enabled']
  )
})

test('a scan whose only finding is a relocated name is still not a pass', () => {
  const outcome = scanForkSymbols({ oldBase, tip, newBase, merged: relocatedOnly })
  assert.deepEqual(
    outcome.results.map((result) => [result.name, result.verdict]),
    [['config.enabled', 'relocated']]
  )
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.summary, /^0 fork-added name\(s\) .*; 1 relocated name\(s\) to review/)
})
