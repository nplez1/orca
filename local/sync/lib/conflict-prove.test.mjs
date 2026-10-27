// Fixture tests for the per-hunk proof tiers and the --apply-proven planner. No git, no filesystem:
//   node --test local/sync/lib/conflict-prove.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'
import { planApplyProven } from './conflict-apply-proven.mjs'
import { proveFile, sha256, upstreamIdentity } from './conflict-prove.mjs'

const hunk = ({ ours, base, theirs }) => [
  '<<<<<<< ours',
  ...ours,
  ...(base === null ? [] : ['||||||| base', ...base]),
  '=======',
  ...theirs,
  '>>>>>>> theirs'
]
const file = (...parts) => [...parts.flat(), ''].join('\n')
const only = (merged, path = 'src/a.ts') => proveFile({ path, merged }).hunks[0]

test('upstream touching only comments and whitespace proves ours', () => {
  const proof = only(
    file(
      hunk({
        ours: ['const x = compute(1, fork)'],
        base: ['// old', 'const x = compute(1)'],
        theirs: ['// reworded by upstream', 'const x =   compute( 1 )']
      })
    )
  )
  assert.equal(proof.tier, 'upstream-unchanged')
  assert.deepEqual(proof.resolution, ['const x = compute(1, fork)'])
})

test('the fork touching only comments proves theirs', () => {
  const proof = only(
    file(
      hunk({
        ours: ['/** fork doc */', 'const x = compute(1)'],
        base: ['const x = compute(1)'],
        theirs: ['const x = compute(2)']
      })
    )
  )
  assert.equal(proof.tier, 'fork-unchanged')
  assert.deepEqual(proof.resolution, ['const x = compute(2)'])
})

test('a line break that changes the parse is not whitespace', () => {
  const proof = only(
    file(
      'function f() {',
      hunk({ ours: ['  return y'], base: ['  return x'], theirs: ['  return', '  x'] }),
      '}'
    )
  )
  assert.equal(proof.tier, null)
})

test('a hunk inside a template literal is never read as code', () => {
  const merged = file(
    'const url = `',
    hunk({
      ours: ['https://a.example'],
      base: ['https://b.example'],
      theirs: ['https://c.example']
    }),
    '`'
  )
  const proof = only(merged)
  assert.equal(proof.tier, null)
  assert.match(proof.reason, /splits a token/)
})

test('a block comment upstream opens in one hunk and closes in the next is refused on both', () => {
  const merged = file(
    hunk({ ours: ['// fork note'], base: ['// note'], theirs: ['/* disabled upstream'] }),
    'legacy()',
    hunk({ ours: ['// fork end'], base: ['// end'], theirs: ['*/'] })
  )
  const result = proveFile({ path: 'src/a.ts', merged })
  assert.equal(result.fullyProven, false)
  assert.deepEqual(
    result.hunks.map((proof) => [proof.tier, proof.reason]),
    [
      [null, 'a comment crosses the hunk edge on the theirs side'],
      [null, 'a comment crosses the hunk edge on the theirs side']
    ]
  )
})

test('upstream removing a comment pair that wrapped context code is refused on both', () => {
  const merged = file(
    hunk({ ours: ['/* off (fork note)'], base: ['/* off'], theirs: ['// re-enabled'] }),
    'legacy()',
    hunk({ ours: ['*/ // fork'], base: ['*/'], theirs: ['// end'] })
  )
  const result = proveFile({ path: 'src/a.ts', merged })
  assert.equal(result.fullyProven, false)
  assert.deepEqual(
    result.hunks.map((proof) => proof.reason),
    [
      'a comment crosses the hunk edge on the base side',
      'a comment crosses the hunk edge on the base side'
    ]
  )
})

test('a hunk wholly inside one comment on every side still proves', () => {
  const proof = only(
    file(
      '/**',
      hunk({ ours: [' * fork words'], base: [' * old words'], theirs: [' * upstream words'] }),
      ' */',
      'export const a = 1'
    )
  )
  assert.equal(proof.tier, 'upstream-unchanged')
})

test('a space on one line of JSX text renders, so upstream removing it is a change', () => {
  const proof = only(
    file(
      hunk({
        ours: ['const el = <p className="fork"><b>{n}</b> items</p>'],
        base: ['const el = <p><b>{n}</b> items</p>'],
        theirs: ['const el = <p><b>{n}</b>items</p>']
      })
    ),
    'src/a.tsx'
  )
  assert.equal(proof.tier, null)
  const reindented = only(
    file(
      hunk({
        ours: ['const el = <p className="fork">', '  some text', '</p>'],
        base: ['const el = <p>', '  some text', '</p>'],
        theirs: ['const el = <p>', '      some text', '</p>']
      })
    ),
    'src/a.tsx'
  )
  assert.equal(reindented.tier, 'upstream-unchanged')
})

test('identity-only takes theirs and re-applies the fork literal', () => {
  const proof = only(
    file(
      hunk({
        ours: ["const appId = 'com.nplez1.orca'", 'const v = 1'],
        base: ["const appId = 'com.stablyai.orca'", 'const v = 1'],
        theirs: ["const appId = 'com.stablyai.orca'", 'const v = 2']
      })
    )
  )
  assert.equal(proof.tier, 'identity-only')
  assert.deepEqual(proof.resolution, ["const appId = 'com.nplez1.orca'", 'const v = 2'])
})

test('identity-only is refused when upstream rewrote the literal itself', () => {
  const proof = only(
    file(
      hunk({
        ours: ["const home = '~/.orca-np'"],
        base: ["const home = '~/.orca'"],
        theirs: ["const home = resolveHome('orca')"]
      })
    )
  )
  assert.equal(proof.tier, null)
})

test('identity-only is refused when the fork rebranded one copy of a literal and kept another', () => {
  const proof = only(
    file(
      hunk({
        ours: ["const cli = 'orca-np'", "const proto = 'orca'"],
        base: ["const cli = 'orca'", "const proto = 'orca'"],
        theirs: ["const cli = 'orca'", "const proto = 'orca'", 'const v = 2']
      })
    )
  )
  assert.equal(proof.tier, null)
})

test('identity-only is refused when upstream adds another copy of the rebranded literal', () => {
  const proof = only(
    file(
      hunk({
        ours: ["const cli = 'orca-np'"],
        base: ["const cli = 'orca'"],
        theirs: ["const cli = 'orca'", "const extra = 'orca'"]
      })
    )
  )
  assert.equal(proof.tier, null)
})

test('upstreamIdentity maps the fork names back, longest first', () => {
  assert.equal(
    upstreamIdentity('com.nplez1.orca ~/.orca-np Orca NP'),
    'com.stablyai.orca ~/.orca Orca'
  )
})

test('import-only is a three-way union that honours a removal', () => {
  const proof = only(
    file(
      hunk({
        ours: [
          "import { a } from './a'",
          "import { gone } from './gone'",
          "import { f } from './fork'"
        ],
        base: ["import { a } from './a'", "import { gone } from './gone'"],
        theirs: ["import { a } from './a'", "import { u } from './upstream'"]
      })
    )
  )
  assert.equal(proof.tier, 'import-only')
  assert.deepEqual(proof.resolution, [
    "import { a } from './a'",
    "import { f } from './fork'",
    "import { u } from './upstream'"
  ])
})

test('import-only is refused when the union would import one module twice', () => {
  const proof = only(
    file(
      hunk({
        ours: ["import { b } from './x'"],
        base: ["import { a } from './x'"],
        theirs: ["import { c } from './x'"]
      })
    )
  )
  assert.equal(proof.tier, null)
})

test('import-only is refused when the union would bind one name twice', () => {
  const proof = only(
    file(
      hunk({
        ours: ["import { a } from './fork-a'"],
        base: ["import { a } from './a'"],
        theirs: ["import { a } from './upstream-a'"]
      })
    )
  )
  assert.equal(proof.tier, null)
})

test('import-only is refused when one side drops an import the other side changed', () => {
  const proof = only(
    file(
      hunk({
        ours: ["import { f } from './fork'"],
        base: ["import { a } from './x'", "import { f } from './fork'"],
        theirs: ["import { a, b } from './x'", "import { f } from './fork'"]
      })
    )
  )
  assert.equal(proof.tier, null)
})

test('import-only is refused when another hunk on the other side binds the same name', () => {
  const result = proveFile({
    path: 'src/a.ts',
    merged: file(
      hunk({
        ours: ["import { a } from './a'", "import { f } from './fork-f'"],
        base: ["import { a } from './a'"],
        theirs: ["import { a } from './a'", "import { b } from './b'"]
      }),
      "import { c } from './c'",
      hunk({
        ours: ["import { d } from './d'", "import { e } from './e'"],
        base: ["import { d } from './d'"],
        theirs: ["import { d } from './d'", "import { f } from './upstream-f'"]
      })
    )
  })
  assert.equal(result.fullyProven, false)
  assert.deepEqual(
    result.hunks.map((proof) => proof.tier),
    [null, null]
  )
})

test('import-only keeps a comment trailing the last import of a side', () => {
  const proof = only(
    file(
      hunk({
        ours: ["import { a } from './a'", "import { f } from './fork' // fork-only"],
        base: ["import { a } from './a'"],
        theirs: ["import { a } from './a'", "import { u } from './u'", '// keep: load order']
      })
    )
  )
  assert.equal(proof.tier, 'import-only')
  assert.deepEqual(proof.resolution, [
    "import { a } from './a'",
    "import { f } from './fork' // fork-only",
    "import { u } from './u'",
    '// keep: load order'
  ])
})

test('without a base section nothing is proven', () => {
  const proof = only(
    file(hunk({ ours: ['const x = 1'], base: null, theirs: ['// c', 'const x = 1'] }))
  )
  assert.equal(proof.tier, null)
  assert.match(proof.reason, /zdiff3/)
})

test('a file is fully proven only when every hunk is, and only then carries a resolution', () => {
  const proven = hunk({
    ours: ['const a = 1'],
    base: ['const a = 0'],
    theirs: ['// c', 'const a = 0']
  })
  const both = hunk({ ours: ['const b = 1'], base: ['const b = 0'], theirs: ['const b = 2'] })
  const partial = proveFile({ path: 'src/a.ts', merged: file(proven, 'mid()', both) })
  assert.equal(partial.fullyProven, false)
  assert.equal(partial.provenHunks, 1)
  assert.equal(partial.resolvedText, undefined)
  const whole = proveFile({ path: 'src/a.ts', merged: file('top()', proven, 'end()') })
  assert.equal(whole.fullyProven, true)
  assert.equal(whole.resolvedText, file('top()', 'const a = 1', 'end()'))
  assert.equal(proveFile({ path: 'docs/a.md', merged: file(proven) }).fullyProven, false)
})

// ---- --apply-proven

const proven = file(
  hunk({ ours: ['const a = 1'], base: ['const a = 0'], theirs: ['// c', 'const a = 0'] })
)
const contested = file(
  hunk({ ours: ['const b = 1'], base: ['const b = 0'], theirs: ['const b = 2'] })
)
const decisionFor = (files) => ({
  mode: 'live',
  files: files.map(([path, merged, extra = {}]) => {
    const { resolvedText: _text, ...proof } = proveFile({ path, merged })
    return { path, status: 'UU', proof, ...extra }
  })
})

const worktree = (readText, unmerged = ['src/p.ts', 'src/c.ts'], links = []) => ({
  readText,
  unmerged: new Set(unmerged),
  isSymlink: (path) => links.includes(path)
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
