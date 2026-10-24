// The gate's judgement, and the manifest it judges with, are both assertions the rest of the fork
// relies on: a wrong verdict either hides a real failure or invents one. No git, no suite:
//   node --test local/gate-unit.test.mjs

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  allowlistEntries,
  collectCases,
  forkTestFiles,
  judge,
  judgeUnhandled,
  quarantinedFiles,
  repoPath
} from './gate-unit.mjs'

const ROOT = join(import.meta.dirname, '..')
// Why rooted at the checkout: the gate reports repo-relative paths, so a fixture outside ROOT would
// exercise the wrong branch of repoPath and match nothing.
const THING = join(ROOT, 'src/main/thing.test.ts')

function customContent(tests) {
  return {
    testResults: [
      {
        name: THING,
        status: tests.some((entry) => entry.status === 'failed') ? 'failed' : 'passed',
        assertionResults: tests.map((entry) => ({
          fullName: entry.test,
          title: entry.test,
          status: entry.status,
          failureMessages: entry.status === 'failed' ? ['AssertionError: boom\n  at x'] : []
        }))
      }
    ]
  }
}

test('a test title is matched by name, so a new failure in the same file is not covered', () => {
  const entries = allowlistEntries({
    entries: [{ file: 'src/main/thing.test.ts', test: 'known case', class: 'c', owner: 'o' }]
  })
  const cases = collectCases(customContent([{ test: 'known case', status: 'failed' }]))
  assert.equal(judge(entries, cases.failures, cases.passes).known.length, 1)

  const widened = collectCases(
    customContent([
      { test: 'known case', status: 'failed' },
      { test: 'a case nobody recorded', status: 'failed' }
    ])
  )
  const judged = judge(entries, widened.failures, widened.passes)
  assert.deepEqual(
    judged.unexpected.map((failure) => failure.test),
    ['a case nobody recorded']
  )
})

test('a file-level entry still covers every case in the file, and is what tightening replaces', () => {
  const entries = allowlistEntries({
    entries: [{ file: 'src/main/thing.test.ts', test: '*', class: 'c', owner: 'o' }]
  })
  const cases = collectCases(
    customContent([
      { test: 'known case', status: 'failed' },
      { test: 'a case nobody recorded', status: 'failed' }
    ])
  )
  const judged = judge(entries, cases.failures, cases.passes)
  assert.equal(judged.known.length, 2)
  assert.equal(judged.unexpected.length, 0)
  assert.equal(entries[0].test, null)
})

test('an entry that passed is stale, and an entry whose file never failed is unseen', () => {
  const entries = allowlistEntries({
    entries: [
      { file: 'src/main/thing.test.ts', test: 'now green', class: 'c', owner: 'o' },
      { file: 'src/main/gone.test.ts', test: '*', class: 'c', owner: 'o' }
    ]
  })
  const cases = collectCases(
    customContent([
      { test: 'now green', status: 'passed' },
      { test: 'still red', status: 'failed' }
    ])
  )
  const judged = judge(entries, cases.failures, cases.passes)
  assert.deepEqual(
    judged.stale.map((entry) => entry.key),
    ['src/main/thing.test.ts › now green']
  )
  assert.deepEqual(
    judged.unseen.map((entry) => entry.key),
    ['src/main/gone.test.ts › *']
  )
})

test('a file that failed to collect is a failure, not an absent one', () => {
  const cases = collectCases({
    testResults: [{ name: THING, status: 'failed', message: 'Cannot find package pg' }]
  })
  assert.deepEqual(cases.failures, [
    {
      file: 'src/main/thing.test.ts',
      test: '(suite)',
      detail: 'Cannot find package pg'
    }
  ])
})

test('an unhandled headline is collapsed and counted, and one nobody declared blocks', () => {
  const judged = judgeUnhandled(
    ['Error: selector_not_found', 'Error: selector_not_found', 'Error: something new'],
    [{ headline: 'Error: selector_not_found', class: 'macos-path-semantics' }]
  )
  assert.deepEqual(
    judged.known.map((entry) => [entry.headline, entry.count]),
    [['Error: selector_not_found', 2]]
  )
  assert.deepEqual(
    judged.blocking.map((entry) => [entry.headline, entry.count]),
    [['Error: something new', 1]]
  )
})

test('repoPath keeps a path outside the checkout as it found it', () => {
  assert.equal(repoPath('/elsewhere/thing.test.ts'), '/elsewhere/thing.test.ts')
  assert.equal(repoPath(join(ROOT, 'src/main/thing.test.ts')), 'src/main/thing.test.ts')
})

test('the fork-local lane finds the sync-tooling tests nothing else runs', () => {
  const files = forkTestFiles()
  assert.ok(files.includes('local/sync/lib/post-sync-checks.test.mjs'))
  assert.ok(files.includes('local/sync/lib/conflict-classify.test.mjs'))
  assert.ok(files.every((file) => file.endsWith('.test.mjs')))
})

const manifest = JSON.parse(readFileSync(join(ROOT, 'local/unit-known-red.json'), 'utf8'))

test('no entry names a file the gate does not run, which would be dead weight', () => {
  const quarantined = new Set(quarantinedFiles())
  assert.ok(quarantined.size > 0, 'UNIT_EXCLUDE and UNIT_INCLUDE must disagree about something')
  for (const entry of manifest.entries) {
    assert.equal(
      quarantined.has(entry.file),
      false,
      `${entry.file} is upstream-quarantined, so an entry for it can never match`
    )
  }
})

test('every entry carries the classification and evidence a reader needs', () => {
  const keys = new Set()
  for (const entry of manifest.entries) {
    assert.ok(entry.file, 'an entry must name a file')
    assert.ok(entry.test && entry.test !== '*', `${entry.file} is still file-level`)
    assert.ok(entry.class, `${entry.file} has no class`)
    assert.ok(entry.owner, `${entry.file} has no owner`)
    assert.ok((entry.evidence ?? '').length > 20, `${entry.file} has no usable evidence`)
    const key = `${entry.file} › ${entry.test}`
    assert.equal(keys.has(key), false, `${key} is listed twice`)
    keys.add(key)
  }
})

test('the recorded run closes its own arithmetic', () => {
  const run = manifest.observedRun
  assert.equal(
    run.allowlisted + run.upstreamQuarantined + run.fixed,
    run.failingRecords,
    `allowlisted ${run.allowlisted} + quarantined ${run.upstreamQuarantined} + fixed ${run.fixed} is not ${run.failingRecords}`
  )
  assert.equal(
    run.allowlisted,
    manifest.entries.length,
    'allowlisted must be the entries in this file'
  )
})
