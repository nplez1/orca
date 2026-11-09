// Upstream's `max-lines` ratchet reports a new bypass and expects a human to allow it. The fork's rule
// (LOCAL-PATCHES.md § local(lint)) is narrower: only an upstream-owned file may be exempted, because
// splitting one costs a permanent hunk on every sync, while the fork's own files must be split. That half
// is checkable, so it is checked here rather than left to a reviewer's memory.
//
// The comparison is against the *recorded sync base*, never a ref tip and never `origin/HEAD` — see
// `lib/upstream-sync-base.mjs` for why. There is no skip: a check that cannot resolve the base fails and
// names the command that fixes it, because a policy check that skips is not a policy check.
//
//   node --test local/max-lines-exemption.test.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
  commitExists,
  commitHasPath,
  fetchCommandFor,
  readRecordedSyncBase
} from './lib/upstream-sync-base.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const BASELINE = 'config/max-lines-baseline.txt'
const KINDS = new Set(['inline', 'mobile-config'])

function parseBaseline(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const [kind, file] = line.split(/\s+/)
      return { kind, path: file }
    })
}

const entries = parseBaseline(readFileSync(path.join(ROOT, BASELINE), 'utf8'))
const base = readRecordedSyncBase(ROOT)
const baseProblem = base
  ? commitExists(ROOT, base)
    ? null
    : `the recorded sync base ${base} is not in this clone: ${fetchCommandFor(base)}`
  : `no sync base is recorded in local/upstream-file-comments-baseline.json — regenerate it with ` +
    '`node local/check-upstream-file-comments.mjs --init --accept "<why>"`'

test('the upstream sync base is recorded and present, so the rule below can be judged', () => {
  assert.equal(baseProblem, null)
})

test('parses every row into a known kind and a path', () => {
  assert.ok(entries.length > 0)
  for (const entry of entries) {
    assert.ok(KINDS.has(entry.kind), `unknown kind in: ${entry.kind} ${entry.path}`)
    assert.ok(entry.path, `row without a path: ${entry.kind}`)
  }
})

test('names files that exist in this tree, so a renamed file cannot leave a stale row', () => {
  for (const entry of entries) {
    const tracked = execFileSync('git', ['ls-files', '--error-unmatch', entry.path], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    assert.equal(tracked.trim(), entry.path)
  }
})

test('exempts only upstream-owned files (the recorded sync base is upstream)', () => {
  assert.equal(baseProblem, null, 'cannot judge upstream ownership without the recorded sync base')
  const forkOwned = entries.filter((entry) => !commitHasPath(ROOT, base, entry.path))
  assert.deepEqual(
    forkOwned.map((entry) => entry.path),
    [],
    'a fork-owned file over the max-lines budget must be split, not exempted: it has no upstream ' +
      'copy to conflict with, so the cap is a free guard there (LOCAL-PATCHES.md § local(lint)). ' +
      'If the file IS upstream-owned, the recorded sync base is older than this sync — re-run ' +
      '`node local/check-upstream-file-comments.mjs --init --accept "<why>"` to move it forward'
  )
})
