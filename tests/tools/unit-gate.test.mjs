import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  allowlistEntries,
  collectCases,
  collectedQuarantinedFiles,
  forkTestFiles,
  judge,
  judgeUnhandled,
  quarantinedEntryProblems,
  quarantinedFiles,
  repoPath
} from '../../local/gate-unit.mjs'

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
          failureMessages: entry.status === 'failed' ? ['AssertionError: boom\n  at x'] : []
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

describe('the fork-local lane', () => {
  it('finds the sync-tooling tests nothing else runs', () => {
    const files = forkTestFiles()
    expect(files).toContain('local/sync/lib/post-sync-checks.test.mjs')
    expect(files).toContain('local/sync/lib/conflict-classify.test.mjs')
    expect(files.every((file) => file.endsWith('.test.mjs'))).toBe(true)
  })
})

const manifest = JSON.parse(readFileSync(join(ROOT, 'local/unit-known-red.json'), 'utf8'))

describe('the known-red manifest', () => {
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
    expect(run.allowlisted).toBe(manifest.entries.length)
    expect(run.fixed).toBe(run.repairedCases.length)
  })
})
