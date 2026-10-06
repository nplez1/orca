// Fixture tests for the pure classification core. No git, no filesystem:
//   node --test local/sync/lib/conflict-classify.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyFile,
  delimiterBalance,
  globMatches,
  ledgerMatches,
  lineDelta,
  parseConflictHunks,
  parseLedger
} from './conflict-classify.mjs'

// Markers are built from array elements so no line of this file starts with a marker.
const HEAD = '<<<<<<<'
const BASE = '|||||||'
const MID = '======='
const END = '>>>>>>>'

const MERGED = (...parts) => parts.join('\n')

function conflict({ ours, theirs, base = null, tail = [], status = 'UU', path = 'src/x.ts' }) {
  const merged = MERGED(
    `${HEAD} HEAD`,
    ...ours,
    ...(base === null ? [] : [`${BASE} merged common ancestors`, ...base]),
    MID,
    ...theirs,
    `${END} upstream/main`,
    ...tail
  )
  return classifyFile({
    path,
    status,
    base: base === null ? null : base.join('\n'),
    ours: ours.join('\n'),
    theirs: theirs.join('\n'),
    merged
  })
}

test('parses hunks, base sections, labels and the shared tail', () => {
  const hunks = parseConflictHunks(
    MERGED(
      'before',
      `${HEAD} ours-label`,
      '  our line',
      `${BASE} base-label`,
      '  base line',
      MID,
      '  their line',
      `${END} theirs-label`,
      '  after',
      'tail two'
    )
  )
  assert.equal(hunks.length, 1)
  assert.deepEqual(hunks[0].ours, ['  our line'])
  assert.deepEqual(hunks[0].base, ['  base line'])
  assert.deepEqual(hunks[0].theirs, ['  their line'])
  assert.deepEqual(hunks[0].tail, ['  after', 'tail two'])
  assert.equal(hunks[0].oursLabel, 'ours-label')
  assert.equal(hunks[0].theirsLabel, 'theirs-label')
  assert.equal(hunks[0].startLine, 2)
})

test('delimiter balance counts outside-in and lineDelta is a multiset difference', () => {
  assert.equal(delimiterBalance(['f(', '  g(']), 2)
  assert.equal(delimiterBalance([')']), -1)
  assert.deepEqual(lineDelta(['a', 'b'], ['a', 'c']), { added: 1, removed: 1 })
  assert.deepEqual(lineDelta(['a'], ['a', 'a']), { added: 1, removed: 0 })
})

test('clean union: both sides balanced and their added lines disjoint', () => {
  const file = conflict({
    base: ['function f() {', '  return 1', '}'],
    ours: ['function f() {', '  const a = 1', '  return 1', '}'],
    theirs: ['function f() {', '  const b = 2', '  return 1', '}']
  })
  assert.equal(file.class, 'union')
  assert.equal(file.hunks[0].class, 'union')
  assert.equal(file.hunks[0].balance.ours, 0)
  assert.equal(file.hunks[0].additionOverlap, 0)
})

test('duplicate-tail: one unbalanced side, closed by the shared tail', () => {
  const file = conflict({
    base: ['  const x = old(1)'],
    ours: ['  const x = makeThing(', '    arg'],
    theirs: ['  const x = makeOther(1)'],
    tail: ['  )']
  })
  assert.equal(file.hunks[0].class, 'duplicate-tail')
  assert.deepEqual(file.hunks[0].duplicateFor, ['ours'])
  assert.equal(file.hunks[0].tailCloses.ours, 1)
  assert.equal(file.hunks[0].tailCloses.theirs, null)
})

test('duplicate-tail: both sides unbalanced and the tail closes both', () => {
  const file = conflict({
    base: ['  return old('],
    ours: ['  return f(', '    a'],
    theirs: ['  return g(', '    b'],
    tail: ['  )']
  })
  assert.equal(file.hunks[0].class, 'duplicate-tail')
  assert.deepEqual(file.hunks[0].duplicateFor, ['ours', 'theirs'])
  assert.equal(file.hunks[0].tailCloses.ours, 1)
  assert.equal(file.hunks[0].tailCloses.theirs, 1)
})

// The trap that produced a real defect: balanced sides must never get the tail duplicated,
// even when the following lines look like they close something.
test('trap: balanced sides with an open-looking tail is not duplicate-tail', () => {
  const file = conflict({
    base: ['  total: compute()'],
    ours: ['  total: computeA()'],
    theirs: ['  total: computeB()'],
    tail: [')', '}', '});']
  })
  assert.notEqual(file.hunks[0].class, 'duplicate-tail')
  assert.equal(file.hunks[0].tailCloses.ours, null)
  assert.equal(file.hunks[0].tailCloses.theirs, null)
})

test('union stays union when both sides add different members', () => {
  const file = conflict({
    base: ['const x = {', '  a: 1,', '}'],
    ours: ['const x = {', '  a: 1,', '  b: 2,', '}'],
    theirs: ['const x = {', '  a: 1,', '  c: 3,', '}']
  })
  assert.equal(file.class, 'union')
  assert.deepEqual(file.hunks[0].sharedMembers, [])
})

test('duplicate-members: a union would repeat a member both sides added', () => {
  const file = conflict({
    base: ['const x = {', '  a: 1,', '}'],
    ours: ['const x = {', '  a: 1,', '  b: 2,', '}'],
    theirs: ['const x = {', '  a: 1,', '  b: 3,', '}']
  })
  assert.equal(file.class, 'duplicate-members')
  assert.deepEqual(file.hunks[0].sharedMembers, ['b'])
})

test('both-rewrote: same existing content changed on both sides', () => {
  const file = conflict({
    base: ['  value: 1,'],
    ours: ['  value: 2,'],
    theirs: ['  value: 3,']
  })
  assert.equal(file.class, 'both-rewrote')
  assert.equal(file.hunks[0].firstDiff.ours, '  value: 2,')
  assert.equal(file.hunks[0].firstDiff.theirs, '  value: 3,')
})

test('rename-replay is a shape match, and a string value change is not', () => {
  const renamed = conflict({
    base: ['  const t = readOld(path)'],
    ours: ['  const t = readForked(path)'],
    theirs: ['  const t = readUpstream(path)']
  })
  assert.equal(renamed.hunks[0].class, 'rename-replay')
  const values = conflict({
    base: ['  const t = read("a.ts")'],
    ours: ['  const t = read("fork.ts")'],
    theirs: ['  const t = read("upstream.ts")']
  })
  assert.equal(values.hunks[0].class, 'both-rewrote')
})

test('add/add and modify/delete come from the status code', () => {
  const addAdd = conflict({ ours: ['a'], theirs: ['b'], status: 'AA' })
  assert.equal(addAdd.class, 'add/add')
  assert.equal(addAdd.sides.base, false)

  const modifyDelete = classifyFile({
    path: 'src/gone.ts',
    status: 'UD',
    base: 'gone\n',
    ours: 'gone\n',
    theirs: null,
    merged: 'gone\n'
  })
  assert.equal(modifyDelete.class, 'modify/delete')
  assert.equal(modifyDelete.sides.theirs, false)
  assert.equal(modifyDelete.hunkCount, 0)
  assert.ok(modifyDelete.notes.some((note) => note.includes('no conflict markers')))
})

test('a deleted-side file with no markers claims no hunk class', () => {
  const file = classifyFile({
    path: 'src/g.ts',
    status: 'DU',
    base: null,
    ours: null,
    theirs: 'x\n',
    merged: null
  })
  assert.equal(file.class, 'modify/delete')
  assert.deepEqual(file.classes, ['modify/delete'])
  assert.ok(file.notes.some((note) => note.includes('merged content unavailable')))
})

test('ledger parse is tolerant and path matching handles ** and {a,b}', () => {
  const sections = parseLedger(
    [
      '# Convergence ledger',
      'preamble that must be ignored',
      '**Paths:** `src/should-not-attach.ts`',
      '',
      '## Rate limits',
      '',
      '**Paths:** `src/main/rate-limits/**`, `src/main/{deepseek,fireworks}/**key*store*`',
      '',
      '**Decision:** the fork line',
      'and the upstream line',
      '',
      '**Why:** because',
      '',
      '**Do not:** drop the gate',
      '- duplicate a member',
      '',
      '## Broken section with no fields',
      'plain text'
    ].join('\n')
  )
  assert.equal(sections.length, 2)
  assert.deepEqual(sections[0].paths, [
    'src/main/rate-limits/**',
    'src/main/{deepseek,fireworks}/**key*store*'
  ])
  assert.deepEqual(sections[0].decision, ['the fork line', 'and the upstream line'])
  assert.deepEqual(sections[0].doNot, ['drop the gate', '- duplicate a member'])
  assert.deepEqual(sections[1].paths, [])

  assert.ok(
    globMatches('src/main/rate-limits/**', 'src/main/rate-limits/service/service-fetch-targets.ts')
  )
  assert.ok(
    globMatches(
      'src/main/{deepseek,fireworks}/**key*store*',
      'src/main/deepseek/provider-key-store.ts'
    )
  )
  assert.ok(!globMatches('src/main/{deepseek,fireworks}/**', 'src/main/rate-limits/x.ts'))
  assert.ok(!globMatches('src/main/rate-limits/*', 'src/main/rate-limits/service/x.ts'))
  assert.deepEqual(
    ledgerMatches(sections, 'src/main/fireworks/fireworks-key-store.ts').map(
      (entry) => entry.title
    ),
    ['Rate limits']
  )
  assert.deepEqual(ledgerMatches(sections, 'src/renderer/other.ts'), [])
})
