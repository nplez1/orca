// The lane's own contract: which files it collects, and that it refuses to pass when there is nothing to
// run or when a file failed. Fixture trees only — the real repository is the lane's own run.
//
//   node --test local/run-fork-tests.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { forkTestFiles, runForkTests } from './run-fork-tests.mjs'

const PASSING = "import test from 'node:test'\ntest('passes', () => {})\n"
const FAILING =
  "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('fails', () => assert.fail('x'))\n"

function fixtureRoot(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orca-fork-tests-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(join(root, 'local'), { recursive: true })
    writeFileSync(join(root, 'local', name), source)
  }
  return root
}

test('a tree with no matching test file fails the lane instead of passing it', (t) => {
  const root = fixtureRoot(t)
  assert.deepEqual(forkTestFiles(root), [])
  assert.equal(runForkTests({ root, stdio: 'ignore' }), 2)
})

test('the lane passes when its files pass and fails when one does not', (t) => {
  const passing = fixtureRoot(t, { 'a.test.mjs': PASSING })
  assert.deepEqual(forkTestFiles(passing), ['local/a.test.mjs'])
  assert.equal(runForkTests({ root: passing, stdio: 'ignore' }), 0)

  const failing = fixtureRoot(t, { 'a.test.mjs': PASSING, 'b.test.mjs': FAILING })
  assert.equal(runForkTests({ root: failing, stdio: 'ignore' }), 1)
})

test('a fork program that cannot start is a lane failure, not a pass', (t) => {
  const root = fixtureRoot(t, { 'a.test.mjs': PASSING })
  assert.equal(runForkTests({ root, program: '/nonexistent/orca-node', stdio: 'ignore' }), 2)
})

test('a non-test module beside them is not collected', (t) => {
  const root = fixtureRoot(t, { 'a.test.mjs': PASSING, 'notes.mjs': 'export const x = 1\n' })
  assert.deepEqual(forkTestFiles(root), ['local/a.test.mjs'])
})
