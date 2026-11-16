// Fixture tests for the --apply-proven planner. No git, no filesystem:
//   node --test local/sync/lib/conflict-apply-proven.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'
import { attachProofs, planApplyProven, renderApplyPlan } from './conflict-apply-proven.mjs'
import { proveFile, sha256 } from './conflict-prove.mjs'
import { everyModule, file, hunk, proveWithIndex, stagesOf } from './conflict-test-fixtures.mjs'

const proven = file(
  hunk({ ours: ['const a = 1'], base: ['const a = 0'], theirs: ['// c', 'const a = 0'] })
)
const contested = file(
  hunk({ ours: ['const b = 1'], base: ['const b = 0'], theirs: ['const b = 2'] })
)
const LIVE = { kind: 'merge', head: '1ce376b27e', headOid: 'a'.repeat(40), subject: 'Merge' }
const decisionFor = (files) => ({
  mode: 'live',
  state: LIVE,
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
  readStages: (path) => stagesOf(original?.[path] ?? readText(path)),
  state: LIVE
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

test('apply-proven run again re-checks what it already wrote and refuses what it cannot', () => {
  const resolved = file('const a = 1')
  const original = { 'src/p.ts': proven, 'src/staged.ts': proven }
  const plan = planApplyProven(
    decisionFor([
      ['src/p.ts', proven],
      ['src/staged.ts', proven]
    ]),
    worktree(() => resolved, ['src/p.ts'], [], original)
  )
  assert.equal(plan.writes.length, 0)
  assert.deepEqual(plan.already, [{ path: 'src/p.ts' }])
  // Its stages are gone once it is staged, so there is nothing to re-check it against.
  assert.deepEqual(
    plan.refused.map((item) => [item.path, item.reason.split(':')[0]]),
    [['src/staged.ts', 'no longer unmerged']]
  )
  const rendered = renderApplyPlan(plan, [])
  assert.match(rendered.split('\n').at(-1), /1 already written by an earlier run.*1 refused/)
})

test('a file the decision says is resolved is refused when the live index now refuses it', () => {
  // An earlier run wrote this; since then the module it imports became a modify/delete nobody kept.
  const merged = file(
    hunk({
      ours: ["import { a } from './a'", "import { f } from './fork'"],
      base: ["import { a } from './a'"],
      theirs: ["import { a } from './a'", '// upstream note']
    })
  )
  const decision = decisionFor([['src/p.ts', merged]])
  const written = file("import { a } from './a'", "import { f } from './fork'")
  assert.equal(decision.files[0].proof.resolvedSha, sha256(written))
  const plan = planApplyProven(decision, {
    ...worktree(() => written, ['src/p.ts'], [], { 'src/p.ts': merged }),
    moduleExists: (path) => path === 'src/a.ts'
  })
  assert.deepEqual(plan.already, [])
  assert.match(plan.refused[0].reason, /live index now refuses: .*\.\/fork/)
})

test('a decision proposed for another operation is refused whole', () => {
  const decision = decisionFor([['src/p.ts', proven]])
  for (const state of [
    { ...LIVE, headOid: 'b'.repeat(40) },
    { ...LIVE, head: 'ffffffffff' },
    null
  ]) {
    assert.throws(
      () => planApplyProven(decision, { ...worktree(() => proven), state }),
      /re-run --propose/
    )
  }
  // A re-worded MERGE_MSG is not another operation.
  const reworded = planApplyProven(decision, {
    ...worktree(() => proven),
    state: { ...LIVE, subject: 'x' }
  })
  assert.equal(reworded.writes.length, 1)
})

test('attachProofs proves against the index facts it is handed, and says how many it proved', () => {
  const merged = file(
    hunk({
      ours: ["import { a } from './a'", "import { f } from './fork'"],
      base: ["import { a } from './a'"],
      theirs: ["import { a } from './a'", "import { b } from './b'"]
    })
  )
  const files = [{ path: 'src/p.ts', status: 'UU' }]
  const prove = (stages) =>
    attachProofs(files, {
      merged: new Map([['src/p.ts', merged]]),
      stages,
      moduleExists: { exists: (path) => ['src/a.ts', 'src/b.ts', 'src/fork.ts'].includes(path) }
    })
  const note = prove(new Map([['src/p.ts', stagesOf(merged)]]))
  assert.equal(files[0].proof.fullyProven, true)
  assert.equal(files[0].proof.resolvedText, undefined)
  assert.match(note, /^proof: 1 of 1 hunk\(s\) proven; 1 of 1 path/)
  prove(new Map())
  assert.equal(files[0].proof.fullyProven, false)
})

test('a file with no hunks says why it is manual', () => {
  const plan = planApplyProven(
    {
      mode: 'live',
      state: LIVE,
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
      state: LIVE,
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
