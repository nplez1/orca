// Fixture tests for the identity baseline: the comparison the gate runs, and the shape it freezes.
// No git, no filesystem beyond a temp baseline file:
//   node --test local/sync/lib/identity-baseline.test.mjs

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  BASELINE_PATH,
  buildBaseline,
  compareIdentityBaseline,
  describeComparison,
  readIdentityBaseline,
  rewriteRefusal,
  summarizeReportOnly
} from './identity-baseline.mjs'

const hit = (rule, file) => ({ rule, file, line: 1, text: 'x' })
const baselineFor = (hits) => buildBaseline(hits, { base: 'abc123', note: 'n' })

test('the frozen shape is per rule and per file, with a total', () => {
  const summary = summarizeReportOnly([
    hit('home-dir-unknown', 'src/a.ts'),
    hit('home-dir-unknown', 'src/a.ts'),
    hit('bundle-id', 'src/b.ts')
  ])
  assert.deepEqual(summary, {
    rules: { 'bundle-id': { 'src/b.ts': 1 }, 'home-dir-unknown': { 'src/a.ts': 2 } },
    total: 3
  })
})

test('a finding in a file the baseline has never seen fails, and names rule and file', () => {
  const baseline = baselineFor([hit('home-dir-unknown', 'src/a.ts')])
  const comparison = compareIdentityBaseline({
    baseline,
    reportOnly: [hit('home-dir-unknown', 'src/a.ts'), hit('home-dir-unknown', 'src/new.ts')]
  })
  assert.equal(comparison.clean, false)
  assert.deepEqual(comparison.appeared, [
    { rule: 'home-dir-unknown', file: 'src/new.ts', count: 1 }
  ])
  assert.ok(
    describeComparison(comparison).some((line) =>
      line.includes('home-dir-unknown: src/new.ts — new')
    )
  )
})

test('a rule the baseline has never seen fails on its pairs, not on the rule existing', () => {
  const baseline = baselineFor([hit('home-dir-unknown', 'src/a.ts')])
  const comparison = compareIdentityBaseline({
    baseline,
    reportOnly: [hit('home-dir-unknown', 'src/a.ts'), hit('brand-new-rule', 'src/b.ts')]
  })
  // The pair is new, so it fails — and what the report names is the pair, not the rule.
  assert.equal(comparison.appeared.length, 1)
  assert.equal(comparison.appeared[0].rule, 'brand-new-rule')
})

test('one more hit in a frozen file fails even when the pair already exists', () => {
  const baseline = baselineFor([hit('home-dir-reader', 'src/a.ts')])
  const comparison = compareIdentityBaseline({
    baseline,
    reportOnly: [hit('home-dir-reader', 'src/a.ts'), hit('home-dir-reader', 'src/a.ts')]
  })
  assert.deepEqual(comparison.grown, [
    { rule: 'home-dir-reader', file: 'src/a.ts', count: 2, allowed: 1 }
  ])
  assert.equal(comparison.clean, false)
})

test('a shrink fails too, because the slack would otherwise be spendable', () => {
  const baseline = baselineFor([hit('home-dir-reader', 'src/a.ts'), hit('bundle-id', 'src/b.ts')])
  const comparison = compareIdentityBaseline({
    baseline,
    reportOnly: [hit('bundle-id', 'src/b.ts')]
  })
  assert.equal(comparison.shrunk, true)
  assert.equal(comparison.clean, false)
  assert.ok(
    describeComparison(comparison).some((line) => line.includes('--baseline-prune')),
    'the report has to say how to lock the shrink in'
  )
  assert.deepEqual(comparison.stale, [{ rule: 'home-dir-reader', file: 'src/a.ts', allowed: 1 }])
})

test('an exact match is clean', () => {
  const hits = [hit('home-dir-reader', 'src/a.ts'), hit('bundle-id', 'src/b.ts')]
  const comparison = compareIdentityBaseline({ baseline: baselineFor(hits), reportOnly: hits })
  assert.equal(comparison.clean, true)
  assert.equal(comparison.total, 2)
})

test('a missing or malformed baseline is a problem, never "no findings"', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'identity-baseline-'))
  try {
    assert.match(readIdentityBaseline(dir).problem, /is missing/)
    const file = path.join(dir, BASELINE_PATH)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '{"rules":{}}')
    assert.match(readIdentityBaseline(dir).problem, /no numeric total/)
    writeFileSync(file, 'not json')
    assert.match(readIdentityBaseline(dir).problem, /not valid JSON/)
    writeFileSync(file, '{"total":0,"rules":{}}')
    assert.equal(readIdentityBaseline(dir).problem, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a rewrite may not absorb a new or grown pair without a reason, in either mode', () => {
  const baseline = baselineFor([hit('home-dir-reader', 'src/a.ts')])
  const comparison = compareIdentityBaseline({
    baseline,
    reportOnly: [hit('home-dir-reader', 'src/a.ts'), hit('home-dir-reader', 'src/a.ts')]
  })
  // A count that grew is growth even though no new pair appeared.
  assert.match(rewriteRefusal({ mode: 'init', comparison }), /1 grown rule\/file pair/)
  assert.match(rewriteRefusal({ mode: 'prune', comparison }), /only ever lowers/)

  // And a new pair is growth even when the total fell, which is what prune used to record.
  const fell = compareIdentityBaseline({
    baseline: baselineFor([hit('home-dir-reader', 'src/a.ts'), hit('bundle-id', 'src/b.ts')]),
    reportOnly: [hit('home-dir-reader', 'src/a.ts'), hit('bundle-id', 'src/new.ts')]
  })
  assert.equal(fell.total, fell.totalAllowed)
  assert.match(rewriteRefusal({ mode: 'prune', comparison: fell }), /1 new and 0 grown/)

  // A pure shrink is what prune exists for, so it is never a refusal.
  const shrunk = compareIdentityBaseline({
    baseline: baselineFor([hit('home-dir-reader', 'src/a.ts'), hit('bundle-id', 'src/b.ts')]),
    reportOnly: [hit('home-dir-reader', 'src/a.ts')]
  })
  assert.equal(rewriteRefusal({ mode: 'prune', comparison: shrunk }), null)
})
