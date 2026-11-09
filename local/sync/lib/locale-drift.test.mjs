// Fixture tests for the locale-drift row: the comparison, and the git read it drives.
//   node --test local/sync/lib/locale-drift.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'
import { LOCALES_DIR, localeDrift, localeDriftReport } from './locale-drift.mjs'
import { git, gitText } from './run.mjs'
import { tempGitRepo } from './temp-git-repo.mjs'

const base = 'deadbeef00deadbeef00deadbeef00deadbeef00'

test('a locale file that differs from upstream fails, and every one is named', () => {
  const report = localeDriftReport({
    base,
    changed: [`${LOCALES_DIR}/en.json`, `${LOCALES_DIR}/de.json`]
  })
  assert.equal(report.clean, false)
  assert.deepEqual(report.files, [`${LOCALES_DIR}/de.json`, `${LOCALES_DIR}/en.json`])
  assert.match(report.detail, /2 locale file\(s\) differ from upstream at deadbeef00/)
})

test('an untouched locales directory is clean', () => {
  const report = localeDriftReport({ base, changed: [] })
  assert.equal(report.clean, true)
  assert.match(report.detail, /byte-identical to upstream/)
})

test('one deleted key in one catalog is a failure, and an identical tree is not', () => {
  const repo = tempGitRepo('locale-drift-')
  try {
    const locale = `${LOCALES_DIR}/en.json`
    repo.commit('upstream', { [locale]: '{\n  "a": "A",\n  "b": "B"\n}\n', 'src/x.ts': 'x\n' })
    const upstream = repo.git('rev-parse', 'HEAD')

    repo.commit('fork, no drift', { 'src/y.ts': 'y\n' })
    const clean = localeDriftReport({
      base: upstream,
      changed: diff(repo, upstream)
    })
    assert.equal(clean.clean, true, 'a tree that matches upstream must not be red')

    repo.commit('fork drops a key', { [locale]: '{\n  "a": "A"\n}\n' })
    const drifted = localeDriftReport({ base: upstream, changed: diff(repo, upstream) })
    assert.equal(drifted.clean, false)
    assert.deepEqual(drifted.files, [locale])
  } finally {
    repo.remove()
  }
})

// The row's own git read, against the fixture repo rather than the real one.
function diff(repo, from) {
  const out = repo.git('diff', '--name-only', '-z', from, 'HEAD', '--', LOCALES_DIR)
  return out.split('\0').filter(Boolean)
}

test('the row itself reads the tree, and reports one of its three verdicts', () => {
  // The row is the only place the ruler is resolved, so it has to be called at least once: a test that
  // re-implements the git read passes with the row pointed at the wrong ref.
  const outcome = localeDrift()
  assert.ok(['passed', 'failed', 'unavailable'].includes(outcome.status), outcome.status)
  assert.ok(Array.isArray(outcome.details))
  if (outcome.status === 'passed') {
    assert.match(outcome.summary, /byte-identical to upstream/)
  }
  const merged = gitText(['merge-base', 'HEAD', 'upstream/main'])
  if (merged !== null) {
    // The row measures the merge base, so a clone that has the remote must not report N/A.
    assert.notEqual(outcome.status, 'unavailable')
  } else {
    assert.equal(git(['rev-parse', '--verify', 'upstream/main']).ok, false)
  }
})
