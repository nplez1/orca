// Fixture tests for the progress line: the index pass, the status-code tally and its rendering. No
// git, no filesystem — gitText and worktreeText are fakes:
//   node --test local/sync/lib/conflict-progress.test.mjs

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  countByCode,
  countSegment,
  countUnstagedFixes,
  indexStatus,
  liveProgress,
  progressLine,
  treeProgress
} from './conflict-progress.mjs'

const gitText = (records) => (args) =>
  args[0] === 'status'
    ? records.join('\u0000')
    : ['src/p.ts', 'src/c.ts', 'src/d.ts'].join('\u0000')

test('indexStatus splits unmerged codes from what the merge staged', () => {
  const { statuses, staged } = indexStatus(
    gitText([
      'UU src/p.ts',
      'UD src/c.ts',
      'DD src/d.ts',
      'M  src/staged.ts',
      ' M src/unstaged.ts',
      '?? src/untracked.ts',
      'R  src/new.ts',
      'src/old.ts'
    ])
  )
  assert.deepEqual(
    [...statuses],
    [
      ['src/p.ts', 'UU'],
      ['src/c.ts', 'UD'],
      ['src/d.ts', 'DD']
    ]
  )
  // A rename record carries its original path in the next record, which has no status code of its own.
  assert.deepEqual([...staged], ['src/staged.ts', 'src/new.ts'])
})

test('countByCode tallies only paths git still calls unmerged', () => {
  const statuses = new Map([
    ['a', 'UU'],
    ['b', 'UU'],
    ['c', 'UD']
  ])
  assert.deepEqual(countByCode(['a', 'b', 'c', 'd'], statuses), { UU: 2, UD: 1 })
})

test('countSegment orders by count then code, and names the total alone when there are no codes', () => {
  assert.equal(countSegment(4, { UD: 1, UU: 2, DU: 1 }), 'unmerged 4 (UU 2, DU 1, UD 1)')
  assert.equal(countSegment(0, {}), 'unmerged 0')
})

test('countUnstagedFixes skips delete-shaped paths and counts marker-free worktree copies', () => {
  const statuses = new Map([
    ['src/p.ts', 'UU'],
    ['src/c.ts', 'UD'],
    ['src/d.ts', 'UU'],
    ['src/e.ts', 'UU']
  ])
  const disk = {
    'src/p.ts': 'const a = 1\n',
    'src/c.ts': 'const c = 1\n',
    'src/d.ts': '<<<<<<< ours\nconst d = 1\n=======\nconst d = 2\n>>>>>>> theirs\n'
  }
  const count = countUnstagedFixes([...statuses.keys()], statuses, (path) => disk[path] ?? null)
  // p.ts is fixed and unstaged; c.ts is delete-shaped (a `git rm` decision, not a fix); d.ts still has
  // markers; e.ts is absent from disk, which is not a fix either.
  assert.equal(count, 1)
})

test('progressLine renders one line, and the batch segment only when a batch is given', () => {
  const progress = liveProgress({
    gitText: gitText(['UU src/p.ts', 'UU src/c.ts', 'UD src/d.ts', 'M  src/staged.ts']),
    worktreeText: (path) =>
      path === 'src/p.ts'
        ? 'const p = 1\n'
        : '<<<<<<< ours\nconst c = 1\n=======\nconst c = 2\n>>>>>>> theirs\n'
  })
  assert.deepEqual(progress.byCode, { UU: 2, UD: 1 })
  assert.equal(progress.staged, 1)
  assert.equal(progress.provenUnstaged, 1)
  assert.equal(
    progressLine(progress),
    'unmerged 3 (UU 2, UD 1) · staged since merge 1 · proven-unstaged 1'
  )
  const dir = mkdtempSync(join(tmpdir(), 'orca-conflict-progress-'))
  const batch = join(dir, 'batch-a.txt')
  // A batch's own list is the denominator; `#` comments and blank lines are not paths.
  writeFileSync(batch, '# batch a\nsrc/p.ts\nsrc/gone.ts\n')
  assert.equal(
    progressLine(progress, [{ label: 'a', file: batch }]),
    'unmerged 3 (UU 2, UD 1) · staged since merge 1 · proven-unstaged 1 · batches a 1/2'
  )
  rmSync(dir, { recursive: true, force: true })
})

test('a merge-tree run has no index, so the two index facts read n/a', () => {
  const progress = treeProgress([
    { path: 'src/p.ts', status: 'UU' },
    { path: 'src/c.ts', status: null }
  ])
  assert.equal(
    progressLine(progress),
    'unmerged 2 (UU 1) · staged since merge n/a · proven-unstaged n/a'
  )
})
