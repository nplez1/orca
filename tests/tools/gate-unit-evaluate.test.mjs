import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { evaluate } from '../../local/gate-unit.mjs'

describe('the exit a verdict composes', () => {
  const REVISION = 'a'.repeat(40)
  const FORK_TEST = 'local/unit-gate-judgement.test.mjs'
  const SUITE_FILE = 'src/main/a.test.ts'

  /** A gate run with the spawns, globs and diff replaced: the composition is the thing under test. */
  function gateRun({ report = {}, log = '', run = {}, sources = {} } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'orca-gate-evaluate-'))
    const reportPath = join(dir, 'report.json')
    const logPath = join(dir, 'run.log')
    const allowlist = join(dir, 'known-red.json')
    if (report !== null) {
      writeFileSync(reportPath, JSON.stringify(report))
    }
    writeFileSync(logPath, log)
    writeFileSync(allowlist, JSON.stringify({ entries: [] }))
    const base = {
      run: () => ({ outcome: 'complete', status: 0, elapsedMs: 5, forkTestsPassed: true, ...run }),
      git: (args) => (args.join(' ') === 'rev-parse HEAD' ? REVISION : null),
      diff: () => null,
      runnable: () => [SUITE_FILE],
      quarantined: () => [],
      forkTests: () => [FORK_TEST],
      isolation: (files) =>
        new Map(
          files.map((file) => [
            file,
            { complete: true, failures: new Set(), passes: new Set(), filePassed: false }
          ])
        )
    }
    return {
      result: evaluate(
        { allowlist, vitestArgs: [], timeoutMs: 1000, allowDirty: false },
        { dir, reportPath, logPath, sources: { ...base, ...sources } }
      )
    }
  }

  const passingReport = (name = SUITE_FILE) => ({
    numTotalTests: 1,
    numPassedTests: 1,
    testResults: [
      { name, status: 'passed', assertionResults: [{ fullName: 'one', status: 'passed' }] }
    ]
  })

  const failingReport = {
    numTotalTests: 1,
    numFailedTests: 1,
    testResults: [
      {
        name: SUITE_FILE,
        status: 'failed',
        assertionResults: [{ fullName: 'one', status: 'failed', failureMessages: ['boom'] }]
      }
    ]
  }

  it('passes a green run that names every file the lane should have run', () => {
    const { result } = gateRun({ report: passingReport() })
    expect(result.problems).toEqual([])
    expect(result.unexpected).toEqual([])
    expect(result.exitCode).toBe(0)
  })

  it('fails a green exit whose report omits a file the lane defines', () => {
    const { result } = gateRun({
      report: passingReport(),
      sources: { runnable: () => [SUITE_FILE, 'src/main/b.test.ts'] }
    })
    expect(result.problems.join('\n')).toContain('does not name 1 file(s)')
    expect(result.exitCode).toBe(1)
  })

  it('fails a non-zero exit that nothing at all explains', () => {
    // The composition this pins: no failure in the report and no unhandled error, so status 1 is a
    // run nobody can account for.
    const { result } = gateRun({ report: passingReport(), run: { status: 1 } })
    expect(result.unexpected).toEqual([])
    expect(result.problems.join('\n')).toContain('exited 1')
    expect(result.exitCode).toBe(1)
  })

  it('lets an allowlisted red explain a non-zero exit, which every run on this machine has', () => {
    // Why this must pass: 17 tests are allowlisted reds here, so a full run always exits 1. A gate
    // that refused that would fail every run — the report's completeness is what is checked instead.
    const dir = mkdtempSync(join(tmpdir(), 'orca-gate-allowlisted-'))
    const allowlist = join(dir, 'known-red.json')
    writeFileSync(
      allowlist,
      JSON.stringify({
        entries: [{ file: SUITE_FILE, test: 'one', class: 'known', owner: 'upstream' }]
      })
    )
    const reportPath = join(dir, 'report.json')
    const logPath = join(dir, 'run.log')
    writeFileSync(reportPath, JSON.stringify(failingReport))
    writeFileSync(logPath, '')
    const result = evaluate(
      { allowlist, vitestArgs: [], timeoutMs: 1000, allowDirty: false },
      {
        dir,
        reportPath,
        logPath,
        sources: {
          run: () => ({ outcome: 'complete', status: 1, elapsedMs: 1, forkTestsPassed: true }),
          git: (args) => (args.join(' ') === 'rev-parse HEAD' ? REVISION : null),
          diff: () => null,
          runnable: () => [SUITE_FILE],
          quarantined: () => [],
          forkTests: () => [FORK_TEST],
          isolation: () => new Map()
        }
      }
    )
    expect(result.counts).toEqual({ passed: 0, failed: 1, known: 1 })
    expect(result.unexpected).toEqual([])
    expect(result.problems).toEqual([])
    expect(result.exitCode).toBe(0)
  })

  it('fails the same allowlisted run when the report is missing another file', () => {
    // The hole G2 actually named: a report that describes less than the lane. The allowlisted red may
    // explain the exit; a missing file means the run proves nothing about the suite.
    const { result } = gateRun({
      report: passingReport(),
      run: { status: 1 },
      sources: { runnable: () => [SUITE_FILE, 'src/main/b.test.ts'] }
    })
    expect(result.problems.join('\n')).toContain('does not name 1 file(s)')
    expect(result.exitCode).toBe(1)
  })

  it('fails a run whose unexpected failure reproduces in isolation', () => {
    const { result } = gateRun({ report: failingReport, run: { status: 1 } })
    expect(result.unexpected.map((failure) => failure.test)).toEqual(['one'])
    expect(result.exitCode).toBe(1)
  })

  it('keeps a flaky pass out of the exit code but not out of the summary', () => {
    const { result } = gateRun({
      report: failingReport,
      sources: {
        // Why a resolved diff: an unresolvable one is never waived, so this case needs a branch that
        // provably did not touch the file.
        diff: () => ({ base: 'base', files: new Set(['src/main/unrelated.ts']) }),
        isolation: (files) =>
          new Map(
            files.map((file) => [
              file,
              { complete: true, failures: new Set(), passes: new Set(['one']), filePassed: true }
            ])
          )
      }
    })
    expect(result.unexpected).toEqual([])
    expect(result.flaky).toEqual([{ file: SUITE_FILE, test: 'one' }])
    // The suite exited 0 in this fixture, so the waive is the whole story.
    expect(result.exitCode).toBe(0)
  })

  it('fails when the fork-local lane failed, whatever the suite report says', () => {
    const { result } = gateRun({
      report: passingReport(),
      run: { outcome: 'fork-local tests failed', status: null, forkTestsPassed: false }
    })
    expect(result.problems.join('\n')).toContain('fork-local tests failed')
    expect(result.forkTests).toEqual({ files: 1, passed: false })
    expect(result.exitCode).toBe(1)
  })

  it('fails when no fork-local test file was collected at all', () => {
    const { result } = gateRun({ report: passingReport(), sources: { forkTests: () => [] } })
    expect(result.problems.join('\n')).toContain('no fork-local test file matched')
    expect(result.exitCode).toBe(1)
  })

  it('reports a stale entry without failing the gate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-gate-stale-'))
    const allowlist = join(dir, 'known-red.json')
    writeFileSync(
      allowlist,
      JSON.stringify({
        entries: [{ file: SUITE_FILE, test: '*', class: 'x', owner: 'y' }]
      })
    )
    const reportPath = join(dir, 'report.json')
    const logPath = join(dir, 'run.log')
    writeFileSync(reportPath, JSON.stringify(passingReport()))
    writeFileSync(logPath, '')
    const result = evaluate(
      { allowlist, vitestArgs: [], timeoutMs: 1000, allowDirty: false },
      {
        dir,
        reportPath,
        logPath,
        sources: {
          run: () => ({ outcome: 'complete', status: 0, elapsedMs: 1, forkTestsPassed: true }),
          git: (args) => (args.join(' ') === 'rev-parse HEAD' ? REVISION : null),
          diff: () => null,
          runnable: () => [SUITE_FILE],
          quarantined: () => [],
          forkTests: () => [FORK_TEST],
          isolation: () => new Map()
        }
      }
    )
    expect(result.stale.map((entry) => entry.key)).toEqual([`${SUITE_FILE} › *`])
    expect(result.exitCode).toBe(0)
  })

  it('fails when the suite wrote no report, so a crashed run is never green', () => {
    const { result } = gateRun({ report: null })
    expect(result.problems.join('\n')).toContain('no Vitest JSON report was written')
    expect(result.exitCode).toBe(1)
  })

  it('lets the tolerated Vitest teardown race explain a non-zero exit', () => {
    // The one non-zero exit with no failing test behind it that the fork deliberately tolerates: the
    // check has to keep accepting it, or every run that hits the race reds the release gate.
    const { result } = gateRun({
      report: passingReport(),
      run: { status: 1 },
      log: 'Unhandled Rejection\nEnvironmentTeardownError: [vitest-worker]: Closing rpc while "onUserConsoleLog" was pending\n'
    })
    expect(result.unhandled.tolerated).toBe(1)
    expect(result.problems).toEqual([])
    expect(result.exitCode).toBe(0)
  })

  it('fails a non-zero exit an unfiled headline does not explain away', () => {
    const { result } = gateRun({
      report: passingReport(),
      run: { status: 1 },
      log: 'Unhandled Rejection\nError: something nobody recorded\n'
    })
    expect(result.unhandled.blocking).toHaveLength(1)
    expect(result.exitCode).toBe(1)
  })
})
