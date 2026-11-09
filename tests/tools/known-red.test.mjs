// The shared known-red matcher, and the two claims issue #317 is done when they hold:
//
//   1. a new error in an allowlisted test is reported as unexpected — by the gate's judge, by the
//      nightly red-set judge and by the unit-shard verdict, which used to disagree;
//   2. a skipped e2e spec that was selected fails the verdict.
//
// The fixtures are shaped like Vitest's jest-format JSON reporter (what `collectCases` reads) and
// like Playwright's JSON reporter (what the e2e verdict reads), because the point is the shape the
// callers actually see, not a shape invented here.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SUITE_FAILURE,
  collectCases,
  compileMatch,
  entryFileMatches,
  entryIdentifiesTest,
  entryMatchProblems,
  entryMatchesFailure,
  failureDetail,
  judgeEntries,
  judgeUnhandled,
  normaliseEntries,
  normaliseUnhandled
} from '../../local/lib/known-red.mjs'
import { judge } from '../../local/unit-gate-judgement.mjs'
import {
  indexShardReports,
  judgeLinuxFailures,
  judgeParity
} from '../../local/lib/linux-parity.mjs'
import { decideUnitShardVerdict } from '../../local/check-unit-shard-verdict.mjs'
import {
  collectOutcomes,
  decideE2eVerdict,
  selectedFiles,
  titleKeys
} from '../../local/check-e2e-known-failure-titles.mjs'
import { entryProblem } from '../../local/gate-lint.mjs'

const ROOT = resolve(import.meta.dirname, '../..')

const FILE = 'src/main/thing.test.ts'
const TEST = 'SQLite runtime contract admits the actual runtime driver'

/** One allowlisted entry, with the cause it pins. */
const ENTRY = {
  file: FILE,
  test: TEST,
  class: 'sqlite-binding',
  owner: 'environment',
  match: '^cannot add rowid alias'
}

function vitestReport({ failures = [], passes = [], fileMessage = null } = {}) {
  return {
    numTotalTests: failures.length + passes.length,
    numFailedTests: failures.length,
    testResults: [
      {
        name: FILE,
        status: failures.length > 0 || fileMessage ? 'failed' : 'passed',
        ...(fileMessage ? { message: fileMessage } : {}),
        assertionResults: [
          ...failures.map(([test, message]) => ({
            fullName: test,
            status: 'failed',
            failureMessages: message ? [message] : []
          })),
          ...passes.map((test) => ({ fullName: test, status: 'passed' }))
        ]
      }
    ]
  }
}

function linuxIndex(report) {
  return indexShardReports([{ source: 'shard-0.json', report }])
}

describe('a new error in an allowlisted test is unexpected, in every judge', () => {
  // The failure the issue was filed for: same file, same title, a cause nobody recorded.
  const newCause = vitestReport({ failures: [[TEST, 'Error: TypeError: totally new bug']] })
  const recorded = { ...newCause }

  it('is unexpected to the gate, and the entry is reported drifted rather than unseen', () => {
    const { entries } = normaliseEntries([ENTRY])
    const cases = collectCases(recorded)
    const judged = judge(entries, cases.failures, cases.passes)
    expect(judged.unexpected.map((failure) => failure.test)).toEqual([TEST])
    expect(judged.known).toEqual([])
    // Why drifted and not unseen: the test is still red, so calling the entry prunable would delete a
    // live entry the first full run after a new cause appeared.
    expect(judged.drifted.map((item) => item.entry.key)).toEqual([`${FILE} › ${TEST}`])
    expect(judged.unseen).toEqual([])
  })

  it('is unexpected to the nightly red-set judge', () => {
    const result = judgeLinuxFailures(
      { entries: [{ ...ENTRY, evidence: 'failed on Linux three times' }] },
      linuxIndex(recorded)
    )
    expect(result.ok).toBe(false)
    expect(result.unexpected).toHaveLength(1)
    expect(result.allowlisted).toEqual([])
    expect(result.drifted).toHaveLength(1)
    expect(result.stale).toEqual([])
  })

  it('is unexpected to the unit-shard verdict', () => {
    const verdict = decideUnitShardVerdict({
      reportText: JSON.stringify(recorded),
      logText: '',
      outcome: 'failure',
      knownRed: [ENTRY],
      unhandledErrors: []
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.absorbed).toEqual([])
    expect(verdict.problems).toContain(`failing: ${FILE} › ${TEST}`)
    expect(verdict.problems.join('\n')).toContain('listed test failed for a new cause')
    expect(verdict.prunable).toEqual([])
  })

  it('is still absorbed when the cause is the recorded one', () => {
    const matching = vitestReport({ failures: [[TEST, 'Error: cannot add rowid alias']] })
    const { entries } = normaliseEntries([ENTRY])
    const cases = collectCases(matching)
    expect(judge(entries, cases.failures, cases.passes).unexpected).toEqual([])
    const verdict = decideUnitShardVerdict({
      reportText: JSON.stringify(matching),
      logText: '',
      outcome: 'failure',
      knownRed: [ENTRY],
      unhandledErrors: []
    })
    expect(verdict.ok).toBe(true)
    expect(verdict.absorbed).toEqual([`${FILE} › ${TEST} [sqlite-binding]`])
  })
})

describe('the identity rule', () => {
  const { entries } = normaliseEntries([
    ENTRY,
    { file: FILE, test: 'a sibling case that ends the same way', class: 'other' }
  ])

  it('never absorbs on a name suffix, which is what #317 removed', () => {
    const bare = normaliseEntries([{ ...ENTRY, test: 'admits the actual runtime driver' }]).entries
    const cases = collectCases(
      vitestReport({ failures: [[TEST, 'Error: cannot add rowid alias']] })
    )
    expect(judge(bare, cases.failures, cases.passes).known).toEqual([])
    // A sibling whose title merely contains the entry's does not absorb either.
    const sibling = normaliseEntries([{ ...ENTRY, test: 'runtime driver', match: '.*' }]).entries
    expect(judge(sibling, cases.failures, cases.passes).known).toEqual([])
    expect(entries).toHaveLength(2)
  })

  it('reports the drifted entry from `judgeEntries` itself, which is the shared contract', () => {
    const [entry] = normaliseEntries([ENTRY]).entries
    const cases = collectCases(vitestReport({ failures: [[TEST, 'Error: TypeError: new']] }))
    const judged = judgeEntries([entry], cases.failures, cases.passes)
    expect(judged.unexpected).toHaveLength(1)
    expect(judged.drifted).toEqual([{ failure: cases.failures[0], entry }])
  })

  it('matches a file by `/`-bounded suffix, because a report names the runner checkout', () => {
    expect(entryFileMatches(ENTRY, `/home/runner/work/orca/orca/${FILE}`)).toBe(true)
    expect(entryFileMatches(ENTRY, 'src/main/other/thing.test.ts')).toBe(false)
    // A shared filename in a sibling directory never pairs, which is the collision this rule can cost.
    expect(entryFileMatches({ ...ENTRY, file: 'src/a.test.ts' }, 'src/other/a.test.ts')).toBe(false)
  })

  it('keeps identity and cause apart, so a passed test can still retire its entry', () => {
    const [entry] = normaliseEntries([ENTRY]).entries
    const passed = { file: FILE, test: TEST }
    expect(entryIdentifiesTest(entry, passed)).toBe(true)
    expect(entryMatchesFailure(entry, { ...passed, detail: 'TypeError: new' })).toBe(false)
    expect(entryMatchesFailure(entry, { ...passed, detail: 'cannot add rowid alias' })).toBe(true)
  })

  it('lets a whole-file entry absorb the file-level row and a named entry never', () => {
    const suite = { file: FILE, test: SUITE_FAILURE, detail: 'collect error' }
    expect(entryIdentifiesTest(normaliseEntries([{ file: FILE }]).entries[0], suite)).toBe(true)
    expect(entryIdentifiesTest(ENTRY, suite)).toBe(false)
    // `test: null` is the same file-level form, and `String(null)` must not make it a case named null.
    expect(normaliseEntries([{ file: FILE, test: null }]).entries[0].test).toBeNull()
  })
})

describe('the manifest rule', () => {
  it('reports a non-flaky entry that cannot pin a cause, and accepts a flaky one', () => {
    const { entries } = normaliseEntries([
      ENTRY,
      { file: FILE, test: 'intermittent case', class: 'flaky-class', flaky: true },
      { file: FILE, test: 'forgotten case', class: 'forgotten' }
    ])
    expect(entryMatchProblems(entries)).toEqual([
      expect.stringContaining(
        'has no match and is not flaky: src/main/thing.test.ts › forgotten case'
      )
    ])
  })

  it('reports an unusable regex as a problem and absorbs nothing', () => {
    const { entries, problems } = normaliseEntries([{ ...ENTRY, match: '(' }])
    // One problem, not two: `normaliseEntries` keeps it on the entry and `entryMatchProblems` reports it.
    expect(problems).toEqual([])
    expect(entryMatchProblems(entries)).toEqual([expect.stringContaining('unusable match')])
    expect(compileMatch('(').regex).toBeNull()
    expect(entryMatchesFailure(entries[0], { file: FILE, test: TEST, detail: 'x' })).toBe(false)
  })

  it('reads the cause off the first line, ANSI-stripped and without the reporter prefix', () => {
    const coloured = `\u001b[31mError: expect(received).toBe(expected)\u001b[39m\n  at nowhere`
    expect(failureDetail(coloured)).toBe('expect(received).toBe(expected)')
    // A prefix that is part of the cause is kept.
    expect(failureDetail('DaemonConnectionLostError: Disconnected out of disconnectOnly()')).toBe(
      'DaemonConnectionLostError: Disconnected out of disconnectOnly()'
    )
  })

  it('requires every unhandledErrors entry to name a cause, by match or by exact headline', () => {
    const { entries, problems } = normaliseUnhandled([
      { match: '^Canceled: Canceled$', class: 'third-party-teardown' },
      { headline: 'Exact headline', class: 'exact' },
      { class: 'forgotten' }
    ])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('neither a match nor a headline')
    expect(
      judgeUnhandled(['Canceled: Canceled', 'Exact headline', 'Something else'], entries).blocking
    ).toEqual([{ headline: 'Something else', count: 1 }])
    // An entry that names a cause it cannot test absorbs nothing, not even by its headline.
    const broken = normaliseUnhandled([{ match: '(', headline: 'Exact headline' }]).entries
    expect(judgeUnhandled(['Exact headline'], broken).blocking).toHaveLength(1)
  })

  it('holds every manifest in this tree to it', () => {
    for (const path of ['local/unit-known-red.json', 'local/nightly-linux-known-red.json']) {
      const manifest = JSON.parse(readFileSync(join(ROOT, path), 'utf8'))
      const { entries, problems } = normaliseEntries(manifest)
      expect(problems, path).toEqual([])
      expect(entryMatchProblems(entries), path).toEqual([])
      expect(normaliseUnhandled(manifest.unhandledErrors).problems, path).toEqual([])
    }
    const e2e = JSON.parse(readFileSync(join(ROOT, 'local/e2e-known-failure-titles.json'), 'utf8'))
    expect(entryMatchProblems([...titleKeys(e2e).values()])).toEqual([])
    const lint = JSON.parse(readFileSync(join(ROOT, 'local/lint-known-red.json'), 'utf8'))
    expect(lint.entries.map(entryProblem).filter(Boolean)).toEqual([])
  })
})

describe('the e2e expected-spec check', () => {
  const recorded = {
    file: 'tests/e2e/tabs.spec.ts',
    title: 'New tab works',
    owner: 'upstream',
    observedForkRuns: 4,
    observedUpstreamRuns: 2,
    match: '^expect\\(received\\)\\.toBe\\(expected\\)'
  }

  function spec({ title, results, expectedStatus = 'passed', failed = false }) {
    return {
      file: 'tabs.spec.ts',
      title,
      line: 1,
      column: 1,
      ok: !failed,
      tests: [{ status: failed ? 'unexpected' : 'expected', expectedStatus, results }]
    }
  }

  const report = (specs) => ({
    suites: [{ title: 'tabs.spec.ts', specs, suites: [] }],
    errors: []
  })

  it('fails a selected spec that produced no result, and passes one that declared a skip', () => {
    const selected = selectedFiles('tabs.spec.ts\n')
    const truncated = collectOutcomes(report([spec({ title: 'New tab works', results: [] })]))
    const failed = decideE2eVerdict({
      known: titleKeys({ titles: [recorded] }),
      outcomes: truncated,
      outcome: 'failure',
      selected
    })
    expect(failed.ok).toBe(false)
    expect(failed.problems.join('\n')).toContain('selected spec never ran')

    const declared = collectOutcomes(
      report([spec({ title: 'New tab works', results: [], expectedStatus: 'skipped' })])
    )
    const accepted = decideE2eVerdict({
      known: titleKeys({ titles: [recorded] }),
      outcomes: declared,
      outcome: 'success',
      selected
    })
    expect(accepted.ok).toBe(true)
  })

  it('is skipped when the caller names no selection, and fails on a file the selection lacks', () => {
    const outcomes = collectOutcomes(
      report([
        spec({
          title: 'New tab works',
          results: [
            { status: 'failed', error: { message: 'Error: expect(received).toBe(expected)' } }
          ]
        })
      ])
    )
    const known = titleKeys({ titles: [recorded] })
    expect(decideE2eVerdict({ known, outcomes, outcome: 'failure' }).ok).toBe(true)
    const wrongSelection = decideE2eVerdict({
      known,
      outcomes,
      outcome: 'failure',
      selected: selectedFiles('other.spec.ts\n')
    })
    expect(wrongSelection.ok).toBe(false)
    expect(wrongSelection.problems.join('\n')).toContain('was not selected to run')
    expect(wrongSelection.problems.join('\n')).toContain('selected spec file never ran')
  })
})

describe('the nightly parity question is still about passing, not about causes', () => {
  it('judges a passed test passed even when the entry pins a cause it never failed with', () => {
    const index = linuxIndex(vitestReport({ passes: [TEST] }))
    const result = judgeParity({ entries: [ENTRY] }, index)
    expect(result.ok).toBe(true)
    expect(result.rows[0].status).toBe('passed')
  })
})
