// Fixture tests for the --apply-proven planner. No git, no filesystem:
//   node --test local/sync/lib/conflict-apply-proven.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'
import { planApplyProven, renderApplyPlan } from './conflict-apply-proven.mjs'
import { proveFile, sha256 } from './conflict-prove.mjs'
import { everyModule, file, hunk, proveWithIndex, stagesOf } from './conflict-test-fixtures.mjs'

const proven = file(
  hunk({ ours: ['const a = 1'], base: ['const a = 0'], theirs: ['// c', 'const a = 0'] })
)
const contested = file(
  hunk({ ours: ['const b = 1'], base: ['const b = 0'], theirs: ['const b = 2'] })
)
const decisionFor = (files) => ({
  mode: 'live',
  files: files.map(([path, merged, extra = {}]) => {
    const { resolvedText: _text, ...proof } = proveWithIndex(path, merged)
    return { path, status: 'UU', proof, ...extra }
  })
})

// `readStages` answers from the conflicted text the fixture started from, as the index would.
const worktree = (readText, unmerged = ['src/p.ts', 'src/c.ts'], links = [], original = null) => ({
  readText,
  unmerged: new Set(unmerged),
  isSymlink: (path) => links.includes(path),
  moduleExists: everyModule,
  readStages: (path) => stagesOf(original?.[path] ?? readText(path))
})

test('apply-proven writes the fully proven file and reports the rest', () => {
  const disk = { 'src/p.ts': proven, 'src/c.ts': contested }
  const plan = planApplyProven(
    decisionFor([
      ['src/p.ts', proven],
      ['src/c.ts', contested]
    ]),
    worktree((path) => disk[path] ?? null)
  )
  assert.deepEqual(
    plan.writes.map((write) => [write.path, write.text]),
    [['src/p.ts', file('const a = 1')]]
  )
  assert.deepEqual(
    plan.unproven.map((item) => item.path),
    ['src/c.ts']
  )
})

test('apply-proven refuses a file edited since --propose', () => {
  const plan = planApplyProven(
    decisionFor([['src/p.ts', proven]]),
    worktree(() => `${proven}// edited\n`)
  )
  assert.equal(plan.writes.length, 0)
  assert.match(plan.refused[0].reason, /changed since --propose/)
})

test('apply-proven re-proves rather than trusting a hand-edited decision', () => {
  const decision = decisionFor([['src/c.ts', contested]])
  decision.files[0].proof.fullyProven = true
  decision.files[0].proof.resolvedSha = sha256('anything')
  const plan = planApplyProven(
    decision,
    worktree(() => contested)
  )
  assert.equal(plan.writes.length, 0)
  assert.match(plan.refused[0].reason, /does not reproduce/)
})

test('apply-proven refuses a proven file whose recorded resolution is not the one it re-derives', () => {
  const decision = decisionFor([['src/p.ts', proven]])
  decision.files[0].proof.resolvedSha = sha256('a resolution from another prover')
  const plan = planApplyProven(
    decision,
    worktree(() => proven)
  )
  assert.equal(plan.writes.length, 0)
  assert.match(plan.refused[0].reason, /does not reproduce/)
})

test('apply-proven writes only a path git lists as unmerged, and never through a symlink', () => {
  const decision = decisionFor([
    ['src/p.ts', proven],
    ['src/link.ts', proven]
  ])
  const plan = planApplyProven(
    decision,
    worktree(() => proven, ['src/link.ts'], ['src/link.ts'])
  )
  assert.equal(plan.writes.length, 0)
  assert.deepEqual(
    plan.refused.map((item) => [item.path, item.reason]),
    [
      ['src/p.ts', 'git does not list it as unmerged'],
      ['src/link.ts', 'it is a symlink; writing would follow it']
    ]
  )
  assert.throws(() => planApplyProven(decision, { readText: () => proven }), /unmerged/)
})

test('apply-proven run again reports the files it already wrote, staged or not, and refuses nothing', () => {
  const resolved = file('const a = 1')
  const plan = planApplyProven(
    decisionFor([
      ['src/p.ts', proven],
      ['src/staged.ts', proven]
    ]),
    worktree(() => resolved, ['src/p.ts'], [], { 'src/p.ts': proven, 'src/staged.ts': proven })
  )
  assert.equal(plan.writes.length, 0)
  assert.deepEqual(plan.refused, [])
  assert.deepEqual(plan.already, [
    { path: 'src/p.ts', staged: false },
    { path: 'src/staged.ts', staged: true }
  ])
  const rendered = renderApplyPlan(plan, [])
  assert.match(rendered.split('\n').at(-1), /2 already written by an earlier run.*0 refused/)
})

test('a file with no hunks says why it is manual', () => {
  const plan = planApplyProven(
    {
      mode: 'live',
      files: [
        {
          path: 'src/gone.test.ts',
          status: 'UD',
          proof: proveFile({ path: 'src/gone.test.ts', status: 'UD', merged: 'x' })
        }
      ]
    },
    worktree(() => null)
  )
  assert.equal(plan.unproven[0].hunks, 0)
  assert.match(plan.unproven[0].reasons.join('\n'), /modify\/delete/)
})

test('a ledger deletion is printed as a command, never planned as a write', () => {
  const plan = planApplyProven(
    {
      mode: 'live',
      files: [{ path: 'src/old file.ts', proposal: { action: 'delete', provenance: 'ledger' } }]
    },
    worktree(() => {
      throw new Error('a deletion must not read the file')
    })
  )
  assert.deepEqual(
    plan.removals.map((item) => item.command),
    ["git rm -- 'src/old file.ts'"]
  )
  assert.equal(plan.writes.length, 0)
})

test('a --merge-tree decision has no worktree to write', () => {
  assert.throws(
    () =>
      planApplyProven(
        { mode: 'merge-tree', files: [] },
        worktree(() => null)
      ),
    /live/
  )
})
