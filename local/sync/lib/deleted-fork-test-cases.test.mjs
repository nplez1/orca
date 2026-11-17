// Fixture tests for the case-level half of the upstream-deleted-fork-tests row: which titles a file
// declares, which of them the fork added, and when a baseline records their loss. No git:
//   node --test local/sync/lib/deleted-fork-test-cases.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildCaseBaseline,
  compareDeletedForkCases,
  goneForkCases,
  testTitles
} from './deleted-fork-test-cases.mjs'

test('reads it/test titles in every shape the fork writes, and nothing that only looks like one', () => {
  const source = [
    "it('plain', () => {})",
    'test("double \\"quoted\\"", () => {})',
    "it.skipIf(process.platform === 'win32')('modified', () => {})",
    '  it(',
    "    'wrapped by the formatter',",
    '    async () => {}',
    '  )',
    'it(`template`, () => {})',
    "it('escaped \\'quote\\'', () => {})",
    "it.each([1, 2])('table %s', () => {})",
    "expect(/x/.test('not a case')).toBe(false)",
    "xit('not this either')"
  ].join('\n')
  assert.deepEqual(
    [...testTitles(source)],
    [
      'plain',
      'double "quoted"',
      'modified',
      'wrapped by the formatter',
      'template',
      "escaped 'quote'"
    ]
  )
})

test('a fork-added case gone from every test file at HEAD is reported; a moved one is not', () => {
  const gone = goneForkCases({
    tipSources: new Map([
      ['src/a.test.ts', "it('upstream case')\nit('fork lost')\nit('fork moved')"],
      ['src/fork-only.test.ts', "it('fork file case')"]
    ]),
    baseSources: new Map([['src/a.test.ts', "it('upstream case')"]]),
    headTitles: new Set(['fork moved']),
    baseTitles: new Set(['upstream case'])
  })
  assert.deepEqual(gone, [
    { file: 'src/a.test.ts', title: 'fork lost' },
    { file: 'src/fork-only.test.ts', title: 'fork file case' }
  ])
})

test('a case the fork moved from another upstream file is still upstream’s', () => {
  const gone = goneForkCases({
    tipSources: new Map([['src/fork.test.ts', "it('came from b.test.ts')"]]),
    baseSources: new Map(),
    headTitles: new Set(),
    baseTitles: new Set(['came from b.test.ts'])
  })
  assert.deepEqual(gone, [])
})

const range = { base: 'base1', tip: 'tip1' }
const lost = [{ file: 'src/a.test.ts', title: 'fork lost' }]

test('a case is recorded only by an entry with a reason, for this range', () => {
  const recorded = { ...range, cases: { 'src/a.test.ts': { 'fork lost': 'upstream retired it' } } }
  assert.equal(compareDeletedForkCases({ baseline: recorded, gone: lost, range }).clean, true)
  const other = compareDeletedForkCases({
    baseline: { ...recorded, base: 'other' },
    gone: lost,
    range
  })
  assert.equal(other.clean, false, 'another sync range records nothing')
  assert.deepEqual(other.appeared, lost)
  // A baseline from before the case check has no `cases`, so it accepts none of them.
  const fileOnly = compareDeletedForkCases({ baseline: { ...range, files: {} }, gone: lost, range })
  assert.deepEqual(fileOnly.appeared, lost)
})

test('a recorded case that is back is stale, and a re-init keeps each recorded reason', () => {
  const baseline = { ...range, cases: { 'src/a.test.ts': { 'fork lost': 'why', back: 'why' } } }
  const comparison = compareDeletedForkCases({ baseline, gone: lost, range })
  assert.deepEqual(comparison.stale, [{ file: 'src/a.test.ts', title: 'back' }])
  const written = buildCaseBaseline([...lost, { file: 'src/b.test.ts', title: 'new' }], {
    previous: baseline.cases,
    accepted: 'this run'
  })
  assert.deepEqual(written, {
    'src/a.test.ts': { 'fork lost': 'why' },
    'src/b.test.ts': { new: 'this run' }
  })
})
