// Temp-repo test for the per-content PASS cache behind the typecheck and native-build rows: what counts
// as the same content, and that only a pass is remembered.
//   node --test local/sync/lib/pass-cache.test.mjs

import assert from 'node:assert/strict'
import process from 'node:process'
import test, { after } from 'node:test'
import { tempGitRepo } from './temp-git-repo.mjs'

const { dir: repo, write, commit, remove } = tempGitRepo('orca-pass-cache-')
after(remove)
process.chdir(repo)
const { withPassCache, dependencyState } = await import('./pass-cache.mjs')
const { STATUS } = await import('./run.mjs')

commit('base', { 'src/a.ts': 'export const a = 1\n', 'native/x/main.swift': 'print(1)\n' })

let runs = 0
const cached = (status, extra = {}) =>
  withPassCache({
    name: extra.name ?? 'fixture',
    inputs: extra.inputs ?? { tool: 1 },
    paths: extra.paths,
    noCache: extra.noCache,
    check: () => {
      runs += 1
      return { status, summary: 'ran', details: [] }
    }
  })

test('a pass on unchanged content is reused, and says it was cached', () => {
  runs = 0
  assert.equal(cached(STATUS.passed).summary, 'ran')
  const second = cached(STATUS.passed)
  assert.equal(runs, 1)
  assert.equal(second.status, STATUS.passed)
  assert.match(second.summary, /^clean \(cached: this exact content passed/)
  cached(STATUS.passed, { noCache: true })
  assert.equal(runs, 2, '--no-cache re-runs')
  cached(STATUS.passed, { inputs: { tool: 2 } })
  assert.equal(runs, 3, 'another toolchain is another key')
})

test('an edit or an untracked file is different content', () => {
  cached(STATUS.passed)
  runs = 0
  write({ 'src/a.ts': 'export const a = 2\n' })
  cached(STATUS.passed)
  assert.equal(runs, 1)
  write({ 'src/new.ts': 'export const b = 1\n' })
  cached(STATUS.passed)
  assert.equal(runs, 2)
  cached(STATUS.passed)
  assert.equal(runs, 2)
})

test('a failure is never remembered', () => {
  runs = 0
  write({ 'src/a.ts': 'export const a = 3\n' })
  cached(STATUS.failed, { name: 'red' })
  cached(STATUS.failed, { name: 'red' })
  assert.equal(runs, 2)
})

test('a path-scoped key ignores content outside its paths', () => {
  runs = 0
  cached(STATUS.passed, { name: 'native', paths: ['native'] })
  write({ 'src/a.ts': 'export const a = 4\n' })
  cached(STATUS.passed, { name: 'native', paths: ['native'] })
  assert.equal(runs, 1)
  write({ 'native/x/main.swift': 'print(2)\n' })
  cached(STATUS.passed, { name: 'native', paths: ['native'] })
  assert.equal(runs, 2)
})

test('the installed dependency set is in the key, and git cannot see it', () => {
  write({ '.gitignore': 'node_modules\n' })
  commit('ignore node_modules')
  const absent = dependencyState()
  assert.match(absent, /^node_modules\/\.modules\.yaml:absent/)
  write({ 'node_modules/.modules.yaml': 'hoistPattern: []\n' })
  const installed = dependencyState()
  assert.notEqual(installed, absent, 'a fresh install is a different dependency set')
  assert.match(installed, /^node_modules\/\.modules\.yaml:[0-9a-f]{16}/)
  write({ 'node_modules/.modules.yaml': 'hoistPattern: ["*"]\n' })
  assert.notEqual(dependencyState(), installed, 'a second install is another key')
})
