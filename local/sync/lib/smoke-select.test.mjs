// Fixture tests for the pure smoke-selection core. No git, no filesystem:
//   node --test local/sync/lib/smoke-select.test.mjs
//
// The coupling assertions run through the REAL `branchCoupledPaths` with an injected reader, so
// this file also pins the selector to `local/gate-flake-coupling.mjs`'s idea of "coupled".

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SECONDS_PER_TEST_FILE,
  couplingProvenance,
  droppedTouchedTests,
  estimateSeconds,
  harnessCoupling,
  isTestFile,
  selectSmokeTests,
  unitCandidates
} from './smoke-select.mjs'

const SOURCES = {
  'src/a/b.test.ts': ["import { helper } from './b'", "import { tool } from '../shared/tool'"].join(
    '\n'
  ),
  'src/a/c.test.ts': "import { tool } from '../shared/tool'",
  'src/a/plain.test.ts': "import { nothing } from './nothing'"
}
const readSource = (file) => SOURCES[file] ?? ''

const INCLUDE = ['src/**/*.test.ts']
const EXCLUDE = ['src/**/plain.test.ts']

test('isTestFile matches the repo test/spec suffix and nothing else', () => {
  assert.ok(isTestFile('src/a/b.test.ts'))
  assert.ok(isTestFile('src/a/b.spec.mjs'))
  assert.ok(isTestFile('tests/e2e/x.unit.test.ts'))
  assert.ok(!isTestFile('src/a/b.ts'))
  assert.ok(!isTestFile('src/a/tested.ts'))
})

test('unitCandidates applies include then exclude, sorted', () => {
  const paths = [
    'src/z/b.test.ts',
    'src/a/b.test.ts',
    'src/a/plain.test.ts',
    'src/a/helper.ts',
    'tests/tools/t.test.mjs'
  ]
  assert.deepEqual(unitCandidates(paths, INCLUDE, EXCLUDE), ['src/a/b.test.ts', 'src/z/b.test.ts'])
})

test('the test file itself in the diff is provenance touched', () => {
  const diffSet = new Set(['src/a/b.test.ts'])
  const coupled = ['src/a/b.test.ts', 'src/a/b.ts', 'src/shared/tool.ts']
  assert.deepEqual(couplingProvenance('src/a/b.test.ts', diffSet, coupled), {
    file: 'src/a/b.test.ts',
    provenance: 'touched',
    matched: 'src/a/b.test.ts'
  })
  assert.equal(couplingProvenance('src/a/b.test.ts', new Set(['other.ts']), coupled), null)
})

test('selectSmokeTests: sibling module and one-level import are provenance coupled', () => {
  const selected = selectSmokeTests({
    testFiles: ['src/a/b.test.ts', 'src/a/c.test.ts', 'src/a/plain.test.ts'],
    diffFiles: ['src/a/b.ts', 'src/shared/tool.ts'],
    readSource
  })
  assert.deepEqual(selected, [
    { file: 'src/a/b.test.ts', provenance: 'coupled', matched: 'src/a/b.ts' },
    { file: 'src/a/c.test.ts', provenance: 'coupled', matched: 'src/shared/tool.ts' }
  ])
})

test('self-only coupling is the touched-only selection the CLI exposes as --touched-only', () => {
  const selected = selectSmokeTests({
    testFiles: ['src/a/b.test.ts', 'src/a/c.test.ts'],
    diffFiles: ['src/a/b.ts', 'src/shared/tool.ts', 'src/a/b.test.ts'],
    readSource,
    coupledPaths: (file) => [file]
  })
  assert.deepEqual(selected, [
    { file: 'src/a/b.test.ts', provenance: 'touched', matched: 'src/a/b.test.ts' }
  ])
})

test('a touched test also coupled by its imports keeps provenance touched', () => {
  const selected = selectSmokeTests({
    testFiles: ['src/a/b.test.ts'],
    diffFiles: ['src/a/b.test.ts', 'src/shared/tool.ts'],
    readSource
  })
  assert.deepEqual(selected, [
    { file: 'src/a/b.test.ts', provenance: 'touched', matched: 'src/a/b.test.ts' }
  ])
})

test('a coupled hit is the FIRST diff path in coupling order: self, siblings, imports', () => {
  const selected = selectSmokeTests({
    testFiles: ['src/a/b.test.ts'],
    diffFiles: ['src/shared/tool.ts', 'src/a/b.ts'],
    readSource
  })
  assert.deepEqual(selected, [
    { file: 'src/a/b.test.ts', provenance: 'coupled', matched: 'src/a/b.ts' }
  ])
})

test('droppedTouchedTests separates deleted-by-merge from outside-the-unit-suite', () => {
  const dropped = droppedTouchedTests({
    diffFiles: [
      'src/a/gone.test.ts',
      'src/a/kept.test.ts',
      'src/a/spec-shaped.spec.ts',
      'src/a/not-a-test.ts'
    ],
    candidates: ['src/a/kept.test.ts'],
    treeTestFiles: ['src/a/kept.test.ts', 'src/a/spec-shaped.spec.ts']
  })
  assert.deepEqual(dropped, [
    { file: 'src/a/gone.test.ts', reason: 'absent from the merged tree' },
    {
      file: 'src/a/spec-shaped.spec.ts',
      reason: 'in the merged tree but outside the unit suite'
    }
  ])
})

test('harnessCoupling matches exact paths and trailing-slash directory prefixes', () => {
  const shared = ['config/vitest.config.ts', 'package.json', 'src/packages/process-host/']
  assert.deepEqual(
    harnessCoupling(
      ['src/packages/process-host/host-pool.ts', 'config/vitest.config.ts', 'src/a/b.ts'],
      shared
    ),
    ['config/vitest.config.ts', 'src/packages/process-host/host-pool.ts']
  )
  assert.deepEqual(harnessCoupling(['src/a/b.ts'], shared), [])
})

test('the timing estimate is the plan §6.1 flat rate', () => {
  assert.ok(Math.abs(SECONDS_PER_TEST_FILE - (8.8 * 60) / 526) < 1e-9)
  assert.ok(Math.abs(estimateSeconds(526) - 8.8 * 60) < 1e-9)
})
