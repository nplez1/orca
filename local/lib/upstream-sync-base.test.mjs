// The recorded sync base and what it can be asked about. Fixture repos only: no network, and the real
// baseline is judged by `local/max-lines-exemption.test.mjs`.
//
//   node --test local/lib/upstream-sync-base.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { tempGitRepo } from '../sync/lib/temp-git-repo.mjs'
import {
  SYNC_BASE_RECORD,
  commitExists,
  commitHasPath,
  fetchCommandFor,
  readRecordedSyncBase
} from './upstream-sync-base.mjs'

function recordRoot(record) {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-sync-base-'))
  if (record !== undefined) {
    const file = path.join(root, SYNC_BASE_RECORD)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, typeof record === 'string' ? record : JSON.stringify(record))
  }
  return root
}

test('no record file means no base, so the caller must fail rather than assume one', () => {
  assert.equal(readRecordedSyncBase(recordRoot()), null)
})

test('a record without a commit id, or one that is not a commit id, is no base', () => {
  assert.equal(readRecordedSyncBase(recordRoot({ total: 5269 })), null)
  assert.equal(readRecordedSyncBase(recordRoot({ base: 'not-a-sha' })), null)
  assert.equal(readRecordedSyncBase(recordRoot('{ not json')), null)
})

test('the recorded base is the commit the baseline was keyed to', () => {
  const sha = 'a'.repeat(40)
  assert.equal(readRecordedSyncBase(recordRoot({ base: sha })), sha)
})

test('a path is upstream-owned only where the recorded base carries it', () => {
  const repo = tempGitRepo('orca-sync-base-')
  try {
    const before = repo.commit('upstream work', { 'src/kept.ts': 'export const kept = 1\n' })
    repo.commit('upstream moves on', { 'src/added-later.ts': 'export const later = 1\n' })
    assert.equal(commitHasPath(repo.dir, before, 'src/kept.ts'), true)
    assert.equal(commitHasPath(repo.dir, before, 'src/added-later.ts'), false)
  } finally {
    repo.remove()
  }
})

test('a commit this clone does not carry is reported as absent, with the fetch that fixes it', () => {
  const repo = tempGitRepo('orca-sync-base-')
  try {
    repo.commit('upstream work', { 'src/kept.ts': 'export const kept = 1\n' })
    const absent = 'b'.repeat(40)
    assert.equal(commitExists(repo.dir, absent), false)
    assert.equal(fetchCommandFor(absent), `git fetch --depth=1 origin ${absent}`)
  } finally {
    repo.remove()
  }
})
