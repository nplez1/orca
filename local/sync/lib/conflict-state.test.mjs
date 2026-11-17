// Tests for which operation a worktree is stopped in, and the three commits its stages come from.
// readState reads a throwaway git-dir-shaped folder; liveSides gets fake git answers:
//   node --test local/sync/lib/conflict-state.test.mjs

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { liveSides, readState } from './conflict-state.mjs'

const gitDir = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-conflict-state-'))
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  return dir
}

test('readState names the operation from the git dir, a rebase first', () => {
  const cases = [
    [
      { MERGE_HEAD: 'a'.repeat(40), MERGE_MSG: 'Merge x\n' },
      { kind: 'merge', head: 'aaaaaaaaaa' }
    ],
    [{ CHERRY_PICK_HEAD: 'b'.repeat(40) }, { kind: 'cherry-pick', head: 'bbbbbbbbbb' }],
    [{ REVERT_HEAD: 'c'.repeat(40) }, { kind: 'revert', head: 'cccccccccc' }],
    // A rebase stop also leaves CHERRY_PICK_HEAD-style refs about; the rebase dir wins.
    [
      {
        'rebase-merge/msgnum': '2',
        'rebase-merge/end': '5',
        'rebase-merge/head-name': 'refs/heads/topic',
        'rebase-merge/onto': 'd'.repeat(40),
        CHERRY_PICK_HEAD: 'b'.repeat(40)
      },
      { kind: 'rebase', step: 2, total: 5, branch: 'topic', onto: 'dddddddddd' }
    ],
    [{}, { kind: 'none' }]
  ]
  for (const [files, expected] of cases) {
    const dir = gitDir(files)
    try {
      const state = readState(dir)
      for (const [key, value] of Object.entries(expected)) {
        assert.equal(state[key], value, `${key} for ${Object.keys(files).join(',')}`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('liveSides takes the commits from the operation readState names, not from leftover refs', () => {
  const refs = {
    HEAD: 'h',
    MERGE_HEAD: 'm',
    CHERRY_PICK_HEAD: 'p',
    'p^': 'p1',
    REBASE_HEAD: 'r',
    'r^': 'r1',
    REVERT_HEAD: 'v',
    'v^': 'v1'
  }
  const rev = (ref) => refs[ref] ?? null
  const bases = (output) => (args) => (args[0] === 'merge-base' ? output : null)
  assert.deepEqual(liveSides({ kind: 'merge' }, rev, bases('b\n')), {
    base: 'b',
    ours: 'h',
    theirs: 'm'
  })
  // Two merge bases: the merge used a virtual base no commit holds.
  assert.equal(liveSides({ kind: 'merge' }, rev, bases('b1\nb2\n')), null)
  assert.deepEqual(liveSides({ kind: 'rebase' }, rev, bases('')), {
    base: 'r1',
    ours: 'h',
    theirs: 'r'
  })
  assert.deepEqual(liveSides({ kind: 'cherry-pick' }, rev, bases('')), {
    base: 'p1',
    ours: 'h',
    theirs: 'p'
  })
  assert.deepEqual(liveSides({ kind: 'revert' }, rev, bases('')), {
    base: 'v',
    ours: 'h',
    theirs: 'v1'
  })
  assert.equal(liveSides({ kind: 'none' }, rev, bases('b\n')), null)
})

test('a cherry-pick or revert of a merge refuses: `^` is not the parent the caller named', () => {
  const refs = {
    HEAD: 'h',
    CHERRY_PICK_HEAD: 'p',
    'p^': 'p1',
    'p^2': 'p2',
    REVERT_HEAD: 'r',
    'r^': 'r1',
    'r^2': 'r2'
  }
  const rev = (ref) => refs[ref] ?? null
  const gitText = () => null
  assert.equal(liveSides({ kind: 'cherry-pick' }, rev, gitText), null)
  assert.equal(liveSides({ kind: 'revert' }, rev, gitText), null)
})
