import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { forkTestFiles } from '../../local/gate-unit.mjs'
import { quarantinedFiles } from '../../local/unit-lane-files.mjs'
import {
  allowlistEntries,
  collectCases,
  collectedQuarantinedFiles,
  importedCaseSpecifiers,
  judge,
  judgeUnhandled,
  prunableEntries,
  quarantinedEntryProblems,
  repoPath,
  reproducedFailures,
  reportForFile,
  titleExistsInSource
} from '../../local/unit-gate-judgement.mjs'

const ROOT = join(import.meta.dirname, '..', '..')
// Why rooted at the checkout: the gate reports repo-relative paths, so a fixture outside ROOT would
// exercise the wrong branch of repoPath and match nothing.
const THING = join(ROOT, 'src', 'main', 'thing.test.ts')

function reportFor(assertions) {
  return {
    testResults: [
      {
        name: THING,
        status: assertions.some((entry) => entry.status === 'failed') ? 'failed' : 'passed',
        assertionResults: assertions.map((entry) => ({
          fullName: entry.test,
          title: entry.test,
          status: entry.status,
          failureMessages:
            entry.status === 'failed' ? [entry.message ?? 'AssertionError: boom\n  at x'] : []
        }))
      }
    ]
  }
}

describe('an entry covers exactly what it names', () => {
  it('matches a title by name, so the next failure in that file is still unexpected', () => {
    const entries = allowlistEntries({
      entries: [{ file: 'src/main/thing.test.ts', test: 'known case', class: 'c', owner: 'o' }]
    })
    const known = collectCases(reportFor([{ test: 'known case', status: 'failed' }]))
    expect(judge(entries, known.failures, known.passes).known).toHaveLength(1)

    const widened = collectCases(
      reportFor([
        { test: 'known case', status: 'failed' },
        { test: 'a case nobody recorded', status: 'failed' }
      ])
    )
    expect(
      judge(entries, widened.failures, widened.passes).unexpected.map((failure) => failure.test)
    ).toEqual(['a case nobody recorded'])
  })

  it('still lets a file-level entry cover the whole file, which is what tightening replaces', () => {
    const entries = allowlistEntries({
      entries: [{ file: 'src/main/thing.test.ts', test: '*', class: 'c', owner: 'o' }]
    })
    expect(entries[0].test).toBeNull()
    const cases = collectCases(
      reportFor([
        { test: 'known case', status: 'failed' },
        { test: 'a case nobody recorded', status: 'failed' }
      ])
    )
    const judged = judge(entries, cases.failures, cases.passes)
    expect(judged.known).toHaveLength(2)
    expect(judged.unexpected).toEqual([])
  })

  it('re-arms an entry whose failure now reads differently, when the entry names its reason', () => {
    // Why: matching on the name alone kept calling a new failure known for as long as the test name
    // stayed the same, which is how a proven-environmental entry could start hiding a real one.
    const entries = allowlistEntries({
      entries: [
        {
          file: 'src/main/thing.test.ts',
          test: 'known case',
          class: 'c',
          owner: 'o',
          match: 'mapfile: command not found'
        }
      ]
    })
    const same = collectCases(
      reportFor([
        {
          test: 'known case',
          status: 'failed',
          message: 'Error: bash: mapfile: command not found\n  at x'
        }
      ])
    )
    expect(judge(entries, same.failures, same.passes).known).toHaveLength(1)

    const drifted = collectCases(
      reportFor([
        { test: 'known case', status: 'failed', message: 'AssertionError: expected 1 to be 2' }
      ])
    )
    expect(
      judge(entries, drifted.failures, drifted.passes).unexpected.map((failure) => failure.test)
    ).toEqual(['known case'])
  })

  it('reports an entry that passed as stale and a dead one as unseen', () => {
    const entries = allowlistEntries({
      entries: [
        { file: 'src/main/thing.test.ts', test: 'now green', class: 'c', owner: 'o' },
        { file: 'src/main/gone.test.ts', test: '*', class: 'c', owner: 'o' }
      ]
    })
    const cases = collectCases(
      reportFor([
        { test: 'now green', status: 'passed' },
        { test: 'still red', status: 'failed' }
      ])
    )
    const judged = judge(entries, cases.failures, cases.passes)
    expect(judged.stale.map((entry) => entry.key)).toEqual(['src/main/thing.test.ts › now green'])
    expect(judged.unseen.map((entry) => entry.key)).toEqual(['src/main/gone.test.ts › *'])
  })

  it('reports a named entry a rename left behind, even while its file still reds', () => {
    const entries = allowlistEntries({
      entries: [{ file: 'src/main/thing.test.ts', test: 'the old title', class: 'c', owner: 'o' }]
    })
    const cases = collectCases(reportFor([{ test: 'the new title', status: 'failed' }]))
    const judged = judge(entries, cases.failures, cases.passes)
    expect(judged.unexpected.map((failure) => failure.test)).toEqual(['the new title'])
    expect(judged.stale).toEqual([])
    expect(judged.unseen.map((entry) => entry.key)).toEqual([
      'src/main/thing.test.ts › the old title'
    ])
  })
})

describe('the run a verdict is computed from', () => {
  it('counts a file that failed to collect as a failure, not as an absent one', () => {
    const cases = collectCases({
      testResults: [{ name: THING, status: 'failed', message: 'Cannot find package pg' }]
    })
    expect(cases.failures).toEqual([
      { file: 'src/main/thing.test.ts', test: '(suite)', detail: 'Cannot find package pg' }
    ])
  })

  it('collapses an unhandled headline, counts it, and blocks one nobody declared', () => {
    const judged = judgeUnhandled(
      ['Error: selector_not_found', 'Error: selector_not_found', 'Error: something new'],
      [{ headline: 'Error: selector_not_found', class: 'macos-path-semantics' }]
    )
    expect(judged.known.map((entry) => [entry.headline, entry.count])).toEqual([
      ['Error: selector_not_found', 2]
    ])
    expect(judged.blocking.map((entry) => [entry.headline, entry.count])).toEqual([
      ['Error: something new', 1]
    ])
  })

  it('leaves a path outside the checkout as it found it', () => {
    expect(repoPath('/elsewhere/thing.test.ts')).toBe('/elsewhere/thing.test.ts')
    expect(repoPath(THING)).toBe('src/main/thing.test.ts')
    // Why: a sibling checkout whose name starts with this one's must not read as inside it.
    const sibling = `${ROOT}-x/src/main/thing.test.ts`
    expect(repoPath(sibling)).toBe(sibling.replaceAll('\\', '/'))
  })
})

describe('the upstream-quarantined set', () => {
  it('refuses an entry for a file the gate never runs', () => {
    const entries = allowlistEntries({
      entries: [{ file: 'src/main/thing.test.ts', test: 't', class: 'c', owner: 'o' }]
    })
    expect(quarantinedEntryProblems(entries, ['src/main/thing.test.ts'])).toEqual([
      'allowlist entry for a file the gate does not run (UNIT_EXCLUDE): src/main/thing.test.ts › t'
    ])
    expect(quarantinedEntryProblems(entries, ['src/main/other.test.ts'])).toEqual([])
  })

  it('catches a run that collected one anyway, which means the exclusion stopped applying', () => {
    const report = { testResults: [{ name: THING }, { name: join(ROOT, 'tests', 'e2e', 'x.ts') }] }
    expect(collectedQuarantinedFiles(report, ['tests/e2e/x.ts'])).toEqual(['tests/e2e/x.ts'])
    expect(collectedQuarantinedFiles(report, [])).toEqual([])
    expect(collectedQuarantinedFiles({}, ['tests/e2e/x.ts'])).toEqual([])
  })
})

describe('the isolated re-run', () => {
  const rerun = (over = {}) => ({
    complete: true,
    failures: new Set(),
    passes: new Set(),
    filePassed: false,
    ...over
  })
  const failures = [
    { file: 'src/main/thing.test.ts', test: 'came back', detail: '' },
    { file: 'src/main/thing.test.ts', test: 'went away', detail: '' }
  ]

  it('waives only what the re-run reported as passing', () => {
    const kept = reproducedFailures(failures, rerun({ passes: new Set(['went away']) }))
    expect(kept.map((failure) => failure.test)).toEqual(['came back'])
  })

  it('does not waive a test the same report also failed, or one a hook broke under', () => {
    const both = reproducedFailures(
      failures,
      rerun({ passes: new Set(['went away']), failures: new Set(['went away']) })
    )
    expect(both.map((failure) => failure.test)).toEqual(['came back', 'went away'])
    const hook = reproducedFailures(
      failures,
      rerun({ passes: new Set(['went away']), failures: new Set(['(suite)']) })
    )
    expect(hook.map((failure) => failure.test)).toEqual(['came back', 'went away'])
  })

  it('keeps a failure the re-run never reported, because absence is not evidence', () => {
    expect(reproducedFailures(failures, rerun()).map((failure) => failure.test)).toEqual([
      'came back',
      'went away'
    ])
  })

  it('keeps everything when the re-run produced no usable report', () => {
    expect(
      reproducedFailures(failures, rerun({ complete: false })).map((failure) => failure.test)
    ).toEqual(['came back', 'went away'])
  })

  it('waives a one-off suite error only when the re-run raised none', () => {
    const suite = [{ file: 'src/main/thing.test.ts', test: '(suite)', detail: 'teardown' }]
    // Why not `filePassed`: a file that also holds an allowlisted always-red test can never pass in
    // isolation, so requiring that would make a one-off teardown error unwaivable for ever.
    expect(reproducedFailures(suite, rerun())).toHaveLength(0)
    expect(reproducedFailures(suite, rerun({ filePassed: true }))).toHaveLength(0)
    expect(reproducedFailures(suite, rerun({ failures: new Set(['(suite)']) }))).toHaveLength(1)
    expect(
      reproducedFailures(suite, rerun({ failures: new Set(['(suite)']), filePassed: true }))
    ).toHaveLength(1)
  })

  it('keeps a suite error whose re-run found a red the allowlist never saw', () => {
    // The full run's suite row replaced every named case, so the re-run's `foo` was never judged —
    // waiving the row would pass a real failure nobody read.
    const suite = [{ file: 'src/main/thing.test.ts', test: '(suite)', detail: 'collect' }]
    const found = rerun({ failures: new Set(['foo']) })
    expect(reproducedFailures(suite, found)).toHaveLength(1)
    expect(reproducedFailures(suite, found, { known: new Set(['bar']) })).toHaveLength(1)
    // A named entry covering the re-run's failure is the known case, and a file-level entry covers
    // every case in the file.
    expect(reproducedFailures(suite, found, { known: new Set(['foo']) })).toHaveLength(0)
    expect(reproducedFailures(suite, found, { fileCovered: true })).toHaveLength(0)
  })

  it('reads one file out of a report the selector over-matched', () => {
    const report = {
      numTotalTests: 2,
      testResults: [
        {
          name: THING,
          status: 'failed',
          assertionResults: [
            { fullName: 'a', title: 'a', status: 'passed' },
            { fullName: 'b', title: 'b', status: 'failed', failureMessages: ['boom'] }
          ]
        },
        {
          name: `${THING}x`,
          status: 'passed',
          assertionResults: [{ fullName: 'c', title: 'c', status: 'passed' }]
        }
      ]
    }
    const summary = reportForFile(report, 'src/main/thing.test.ts')
    expect([...summary.passes]).toEqual(['a'])
    expect([...summary.failures]).toEqual(['b'])
    expect(summary.filePassed).toBe(false)
    expect(
      reportForFile({ testResults: [{ name: THING, status: 'passed' }] }, 'src/main/thing.test.ts')
        .filePassed
    ).toBe(true)
  })
})

describe('what the manifest may prune', () => {
  const report = {
    testResults: [
      { name: join(ROOT, 'src', 'suite-only.test.ts'), assertionResults: [] },
      { name: THING, assertionResults: [{ status: 'passed' }] }
    ]
  }
  const entry = (file) => ({ file, key: `${file} › t` })

  it('says nothing about a filtered run, which saw only part of the suite', () => {
    expect(
      prunableEntries([entry('src/main/thing.test.ts')], report, { full: false, complete: true })
    ).toEqual([])
  })

  it('says nothing about a run that did not complete', () => {
    expect(
      prunableEntries([entry('src/main/thing.test.ts')], report, { full: true, complete: false })
    ).toEqual([])
  })

  it('skips a file whose only report entry is a collect failure', () => {
    expect(
      prunableEntries([entry('src/suite-only.test.ts')], report, { full: true, complete: true })
    ).toEqual([])
  })

  it('keeps the entry for a file that reported its cases', () => {
    expect(
      prunableEntries([entry('src/main/thing.test.ts')], report, { full: true, complete: true })
    ).toEqual([entry('src/main/thing.test.ts')])
  })
})

describe('the fork-local lane', () => {
  it('finds the sync-tooling tests nothing else runs', () => {
    const files = forkTestFiles()
    expect(files).toContain('local/sync/lib/post-sync-checks.test.mjs')
    expect(files).toContain('local/sync/lib/conflict-classify.test.mjs')
    expect(files.every((file) => file.endsWith('.test.mjs'))).toBe(true)
  })
})

const manifest = JSON.parse(readFileSync(join(ROOT, 'local/unit-known-red.json'), 'utf8'))

describe('a title the file can still produce', () => {
  const source = `
    describe('SQLite runtime contract', () => {
      it('admits the actual runtime driver', () => {})
      it.each(['a', 'b'])('rejects %s before changing rows', () => {})
    })
  `

  it('finds a plain case through its describe chain', () => {
    expect(
      titleExistsInSource('SQLite runtime contract admits the actual runtime driver', source)
    ).toBe(true)
  })

  it('treats what Vitest substitutes into an each title as a wildcard', () => {
    expect(
      titleExistsInSource('SQLite runtime contract rejects a before changing rows', source)
    ).toBe(true)
    // Why both forms: a `$name` from a table row is substituted the same way as a printf token.
    const rows = `it.each([{ name: 'macos' }])('launches through the $name launcher', () => {})`
    expect(titleExistsInSource('launches through the macos launcher', rows)).toBe(true)
    expect(titleExistsInSource('launches through the $name launcher', rows)).toBe(true)
  })

  it('covers the shapes this repo writes titles in', () => {
    const nested = `describe('outer', () => { describe('inner', () => { it('deep case', () => {}) }) })`
    expect(titleExistsInSource('outer inner deep case', nested)).toBe(true)
    // `src/main/cli/packaged-cli-assets.test.ts` names its table `itRunsUnixShell`.
    const aliased = `itRunsUnixShell.each([['a']])('runs %s', () => {})`
    expect(titleExistsInSource('runs a', aliased)).toBe(true)
    const generic = `it.each<[string]>([['a']])('runs %s', () => {})`
    expect(titleExistsInSource('runs a', generic)).toBe(true)
    const quoted = `describe("main's store", () => { it('keeps a tab\\'s view', () => {}) })`
    expect(titleExistsInSource("main's store keeps a tab's view", quoted)).toBe(true)
    const template = 'it(`reads ${n} rows`, () => {})'
    expect(titleExistsInSource('reads 3 rows', template)).toBe(true)
  })

  it('reports a title the file no longer names, which is the rot this catches', () => {
    expect(titleExistsInSource('SQLite runtime contract rejects undefined bindings', source)).toBe(
      false
    )
    // The whole describe chain has to be there too: a renamed block is the same rot as a deleted case.
    expect(
      titleExistsInSource('Sync database contract admits the actual runtime driver', source)
    ).toBe(false)
    // Why: a skipped or todo case never fails, so an entry naming one can never be a known red.
    expect(titleExistsInSource('old case', `it.skip('old case', () => {})`)).toBe(false)
    expect(titleExistsInSource('later case', `it.todo('later case')`)).toBe(false)
    expect(titleExistsInSource('old case', `describe('outer', () => {})`)).toBe(false)
  })
})

const SPEC_EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.cts', '.mjs', '.js']

/** A test file's own source plus the `.spec` modules it imports its cases from. */
function sourceWithImportedCases(file) {
  const absolute = join(ROOT, file)
  if (!existsSync(absolute)) {
    return ''
  }
  const source = readFileSync(absolute, 'utf8')
  const parts = [source]
  for (const specifier of importedCaseSpecifiers(source)) {
    for (const extension of SPEC_EXTENSIONS) {
      const candidate = join(dirname(absolute), `${specifier}${extension}`)
      if (existsSync(candidate)) {
        parts.push(readFileSync(candidate, 'utf8'))
        break
      }
    }
  }
  return parts.join('\n')
}

describe('a title imported from a spec module', () => {
  it('is found where the spec module writes it', () => {
    // Why this shape: `src/main/runtime/orca-runtime.test.ts` pulls every case in through
    // `await import('./orca-runtime-tests/x.spec')`, so the entry's own file names no title at all.
    const file = 'src/main/runtime/orca-runtime.test.ts'
    const title =
      'OrcaRuntimeService keeps existing-folder imports split by runtime host on the same normalized path'
    expect(importedCaseSpecifiers(sourceWithImportedCases(file)).length).toBeGreaterThan(0)
    expect(titleExistsInSource(title, sourceWithImportedCases(file))).toBe(true)
    // The same title in the file alone, to prove the follow is what found it.
    expect(titleExistsInSource(title, readFileSync(join(ROOT, file), 'utf8'))).toBe(false)
  })
})

describe('the known-red manifest', () => {
  it('names only titles its own file can still produce', () => {
    // Why: the gate learns staleness only from an entry that matched a failure, so an entry for a
    // deleted test never surfaces — it sits in the manifest for as long as nobody re-reads the file.
    const dead = manifest.entries
      .filter((entry) => !titleExistsInSource(entry.test, sourceWithImportedCases(entry.file)))
      .map((entry) => `${entry.file} › ${entry.test}`)
    expect(dead).toEqual([])
  })
  it('names no file the gate does not run, which would be dead weight', () => {
    const quarantined = new Set(quarantinedFiles())
    // Why: if UNIT_INCLUDE and UNIT_EXCLUDE ever agreed completely the check below would be vacuous.
    expect(quarantined.size).toBeGreaterThan(0)
    expect(manifest.entries.filter((entry) => quarantined.has(entry.file))).toEqual([])
  })

  it('carries the classification and evidence a reader needs, once per failure', () => {
    const keys = new Set()
    for (const entry of manifest.entries) {
      expect(entry.file, 'an entry must name a file').toBeTruthy()
      expect(entry.test, `${entry.file} is still file-level`).toBeTruthy()
      expect(entry.test, `${entry.file} is still file-level`).not.toBe('*')
      expect(entry.class, `${entry.file} has no class`).toBeTruthy()
      expect(entry.owner, `${entry.file} has no owner`).toBeTruthy()
      expect((entry.evidence ?? '').length, `${entry.file} has no usable evidence`).toBeGreaterThan(
        20
      )
      const key = `${entry.file} › ${entry.test}`
      expect(keys.has(key), `${key} is listed twice`).toBe(false)
      keys.add(key)
    }
  })

  it('closes the arithmetic of the run it was reconciled with', () => {
    const run = manifest.observedRun
    expect(run.allowlisted + run.upstreamQuarantined + run.fixed).toBe(run.failingRecords)
    // Entries pruned since that run are why the count moves without a new run: a case that stopped
    // failing is removed with the revision that fixed it, and the run it was reconciled with is not
    // re-derived by editing a number.
    expect(run.allowlisted).toBe(manifest.entries.length + (manifest.prunedSince ?? []).length)
    expect(run.fixed).toBe(run.repairedCases.length)
    for (const entry of manifest.prunedSince ?? []) {
      expect(entry.reason ?? '', `${entry.file} was pruned without a reason`).toBeTruthy()
      expect(entry.commit ?? '', `${entry.file} was pruned without a revision`).toBeTruthy()
    }
  })
})
