import { describe, expect, it } from 'vitest'
import {
  SHARED_TEST_INPUTS,
  branchCoupledPaths,
  flakeWaiver,
  packageJsonAffectsTests,
  importSpecifiers,
  sharedHarnessPaths
} from '../../local/gate-flake-coupling.mjs'
import {
  cachedVerdictProblem,
  formatVerdict,
  gateInputsFingerprint,
  resolvedGateCacheDir,
  unitGateCacheDir,
  verdictRecordProblem
} from '../../local/gate-verdict-cache.mjs'
import { branchDiff } from '../../local/gate-unit.mjs'
import {
  NO_RERUN,
  collectCases,
  declaredUnhandledMismatch,
  missingReportedFiles,
  rerunReportsFor,
  reproducedFailures,
  unexplainedSuiteExit
} from '../../local/unit-gate-judgement.mjs'

const noSource = () => ''

describe('a run the report cannot explain fails closed', () => {
  it('passes a clean exit', () => {
    expect(
      unexplainedSuiteExit({
        outcome: 'complete',
        status: 0,
        unexpectedCount: 0,
        blockingUnhandledCount: 0
      })
    ).toBeNull()
  })

  it('passes a non-zero exit that an unexpected failure or a blocking error accounts for', () => {
    const base = { outcome: 'complete', status: 1, unexpectedCount: 39, blockingUnhandledCount: 0 }
    expect(unexplainedSuiteExit(base)).toBeNull()
    expect(
      unexplainedSuiteExit({ ...base, unexpectedCount: 0, blockingUnhandledCount: 1 })
    ).toBeNull()
  })

  it('fails a non-zero exit whose only failures were allowlisted', () => {
    // Why: the machine always carries allowlisted reds, so counting them as an explanation made this
    // check unreachable — a worker crash that printed no failure of its own read as explained.
    expect(
      unexplainedSuiteExit({
        outcome: 'complete',
        status: 1,
        unexpectedCount: 0,
        blockingUnhandledCount: 0
      })
    ).toMatch(/exited 1 .*failing closed/)
  })

  it('fails a non-zero exit with no status at all', () => {
    expect(
      unexplainedSuiteExit({
        outcome: 'complete',
        status: null,
        unexpectedCount: 0,
        blockingUnhandledCount: 0
      })
    ).toMatch(/without a status/)
  })

  it('fails a suite that never finished, whatever it managed to print', () => {
    expect(
      unexplainedSuiteExit({
        outcome: 'timed-out',
        status: null,
        unexpectedCount: 0,
        blockingUnhandledCount: 0
      })
    ).toMatch(/did not run to completion/)
  })

  it('fails a declared count that does not match what could be read, in either direction', () => {
    expect(declaredUnhandledMismatch(2, 2)).toBeNull()
    expect(declaredUnhandledMismatch(0, 0)).toBeNull()
    expect(declaredUnhandledMismatch(null, 3)).toBeNull()
    expect(declaredUnhandledMismatch(2, 1)).toMatch(/declared 2 .*1 could be read/)
    // The base compared with `>`, so a log that yielded more headlines than Vitest declared passed.
    expect(declaredUnhandledMismatch(1, 2)).toMatch(/declared 1 .*2 could be read/)
  })
})

describe('a file error beside an allowlisted failure', () => {
  const failing = (fullName) => ({ fullName, status: 'failed', failureMessages: ['boom'] })
  const passing = (fullName) => ({ fullName, status: 'passed' })

  it('records the teardown error too, so absorbing the named red does not absorb it', () => {
    // `check-unit-shard-verdict.mjs` already ruled on this: an afterAll or teardown error is not the
    // failure a named entry accounts for, and 17 tests are always red here — a file among them that
    // throws in teardown reported green.
    const cases = collectCases({
      testResults: [
        {
          name: '/repo/src/main/a.test.ts',
          status: 'failed',
          message: 'Error: afterAll timed out',
          assertionResults: [failing('an allowlisted red'), passing('a green one')]
        }
      ]
    })
    expect(cases.failures).toEqual([
      {
        file: expect.stringContaining('src/main/a.test.ts'),
        test: 'an allowlisted red',
        detail: 'boom'
      },
      {
        file: expect.stringContaining('src/main/a.test.ts'),
        test: '(suite)',
        detail: 'afterAll timed out'
      }
    ])
  })

  it('still records a file that failed without a failing case and without a message', () => {
    const cases = collectCases({
      testResults: [{ name: 'src/main/b.test.ts', status: 'failed', assertionResults: [] }]
    })
    expect(cases.failures).toEqual([
      {
        file: 'src/main/b.test.ts',
        test: '(suite)',
        detail: 'the file failed without a failing case'
      }
    ])
  })

  it('does not invent a failure in a file that passed, whatever message it carries', () => {
    const cases = collectCases({
      testResults: [
        {
          name: 'src/main/c.test.ts',
          status: 'passed',
          message: 'a console warning',
          assertionResults: [passing('one')]
        }
      ]
    })
    expect(cases.failures).toEqual([])
  })

  it('fails a run whose report omits files the lane should have collected', () => {
    const report = { testResults: [{ name: 'src/main/a.test.ts' }] }
    expect(missingReportedFiles(report, ['src/main/a.test.ts', 'src/main/b.test.ts'])).toEqual([
      'src/main/b.test.ts'
    ])
    expect(missingReportedFiles(report, ['src/main/a.test.ts'])).toEqual([])
    expect(missingReportedFiles({}, ['src/main/a.test.ts'])).toEqual(['src/main/a.test.ts'])
  })
})

describe('one batched isolation re-run, read per file', () => {
  const fileEntry = (name, assertions, status = 'passed') => ({
    name,
    status,
    assertionResults: assertions
  })
  const passing = (fullName) => ({ fullName, status: 'passed' })
  const failing = (fullName, message = 'boom') => ({
    fullName,
    status: 'failed',
    failureMessages: [message]
  })
  const report = {
    testResults: [
      fileEntry(
        'src/main/a.test.ts',
        [passing('one'), failing('two'), failing('three', 'load flake')],
        'failed'
      ),
      fileEntry('src/main/b.test.tsx', [passing('four')]),
      // A positional filter is a substring match, so a batched run can collect a sibling the
      // serial run would not have; it must not bleed into any requested file's reading.
      fileEntry('src/main/b.test.ts', [failing('five')], 'failed')
    ]
  }

  it('keeps the per-file attribution a serial re-run had', () => {
    const reruns = rerunReportsFor(report, ['src/main/a.test.ts', 'src/main/b.test.tsx'])
    const a = reruns.get('src/main/a.test.ts')
    expect(a.complete).toBe(true)
    expect([...a.failures]).toEqual(['two', 'three'])
    expect([...a.passes]).toEqual(['one'])
    expect(a.filePassed).toBe(false)
    const b = reruns.get('src/main/b.test.tsx')
    expect([...b.failures]).toEqual([])
    expect([...b.passes]).toEqual(['four'])
    expect(b.filePassed).toBe(true)
  })

  it('reads a file the batched report never mentions as no report at all', () => {
    const reruns = rerunReportsFor(report, ['src/main/absent.test.ts'])
    const rerun = reruns.get('src/main/absent.test.ts')
    expect(rerun).toBe(NO_RERUN)
    // …which is "every failure reproduced", whatever the caller failed with.
    const failures = [{ file: 'src/main/absent.test.ts', test: 'x', detail: 'boom' }]
    expect(reproducedFailures(failures, rerun)).toEqual(failures)
  })

  it('reports nothing when there was nothing to re-run', () => {
    expect(rerunReportsFor(report, []).size).toBe(0)
    expect(rerunReportsFor(null, ['src/main/a.test.ts']).get('src/main/a.test.ts')).toBe(NO_RERUN)
  })
})

describe('which verdicts may be reused, and which may be recorded', () => {
  const options = { cache: true, allowDirty: false, vitestArgs: [] }
  const completed = { revision: 'a'.repeat(40), clean: true, outcome: 'complete' }
  const cached = { revision: completed.revision, clean: true, gateInputs: 'inputs' }
  const context = { revision: completed.revision, gateInputs: 'inputs' }

  it('reuses a cached verdict recorded for this revision, allowlist, inputs and toolchain', () => {
    expect(cachedVerdictProblem(cached, context)).toBeNull()
  })

  it('refuses a cached verdict about some other run, saying which', () => {
    expect(cachedVerdictProblem({ ...cached, revision: 'b'.repeat(40) }, context)).toMatch(
      /does not name this revision/
    )
    // A cache file from before the revision was recorded must fail closed, not pass.
    expect(cachedVerdictProblem({ ...cached, revision: undefined }, context)).toMatch(
      /does not name this revision/
    )
    expect(cachedVerdictProblem({ ...cached, clean: false }, context)).toMatch(
      /does not prove a clean run/
    )
    expect(cachedVerdictProblem({ ...cached, gateInputs: 'other' }, context)).toMatch(
      /different gate inputs/
    )
  })

  it('records a clean completed run even under --no-cache, so a stale FAIL can be replaced', () => {
    const fresh = { headNow: completed.revision, treeClean: true }
    expect(verdictRecordProblem(options, completed, fresh)).toBeNull()
    expect(verdictRecordProblem({ ...options, cache: false }, completed, fresh)).toBeNull()
  })

  it('refuses to record a dirty, partial, selected or stale run, saying which', () => {
    const fresh = { headNow: completed.revision, treeClean: true }
    expect(verdictRecordProblem({ ...options, allowDirty: true }, completed, fresh)).toMatch(
      /--allow-dirty/
    )
    expect(verdictRecordProblem({ ...options, vitestArgs: ['a'] }, completed, fresh)).toMatch(
      /subset of the suite/
    )
    expect(verdictRecordProblem(options, { ...completed, clean: false }, fresh)).toMatch(/dirty/)
    // A timeout or a failed build says nothing about the revision.
    expect(verdictRecordProblem(options, { ...completed, outcome: 'timed-out' }, fresh)).toMatch(
      /says nothing about the revision/
    )
    expect(verdictRecordProblem(options, completed, { ...fresh, headNow: 'b'.repeat(40) })).toMatch(
      /HEAD moved/
    )
    expect(verdictRecordProblem(options, completed, { ...fresh, treeClean: false })).toMatch(
      /tree changed/
    )
  })

  it('puts the verdict inside the git dir git reports, which a worktree has as a real dir', () => {
    // Why this and not a write probe: `<root>/.git` is a file in a linked worktree, so the gate has
    // to resolve the git dir itself — which it does with `--absolute-git-dir`.
    expect(unitGateCacheDir('/repo/.git/worktrees/wt')).toBe('/repo/.git/worktrees/wt/orca-gate')
  })

  it('keys the verdict cache to the repository, so two worktrees gate a revision once', () => {
    // Why: `--absolute-git-dir` answers with `.git/worktrees/<name>`, so the same SHA gated here and
    // in the main tree ran the full suite twice — 25 minutes of it for the release gate.
    const inWorktree = resolvedGateCacheDir({
      commonDir: '/repo/.git',
      gitDir: '/repo/.git/worktrees/wt',
      root: '/repo'
    })
    const inMainTree = resolvedGateCacheDir({
      commonDir: '/repo/.git',
      gitDir: '/repo/.git',
      root: '/repo'
    })
    expect(inWorktree).toBe('/repo/.git/orca-gate')
    expect(inMainTree).toBe(inWorktree)
  })

  it('falls back to the worktree git dir when no common dir is reported', () => {
    expect(resolvedGateCacheDir({ gitDir: '/repo/.git/worktrees/wt', root: '/repo' })).toBe(
      '/repo/.git/worktrees/wt/orca-gate'
    )
  })

  it('resolves a relative common dir against the root, not the cwd', () => {
    expect(resolvedGateCacheDir({ commonDir: '.git', root: '/repo' })).toBe('/repo/.git/orca-gate')
  })

  it('fingerprints the gate inputs, and only them', () => {
    const inputs = {
      files: { 'local/gate-unit.mjs': 'gate', 'config/.bun-version': '1.4.3' },
      toolchain: { node: 'v24.0.0', bun: '1.4.3' }
    }
    expect(gateInputsFingerprint(inputs)).toBe(gateInputsFingerprint({ ...inputs }))
    expect(
      gateInputsFingerprint({ ...inputs, toolchain: { ...inputs.toolchain, bun: '1.5.0' } })
    ).not.toBe(gateInputsFingerprint(inputs))
    expect(
      gateInputsFingerprint({ ...inputs, files: { ...inputs.files, 'local/gate-unit.mjs': 'x' } })
    ).not.toBe(gateInputsFingerprint(inputs))
  })
})

describe('the summary line', () => {
  const verdict = (overrides = {}) => ({
    revision: 'abcdef1234567890',
    clean: true,
    selectors: [],
    counts: { passed: 3, failed: 1, known: 1 },
    unexpected: [],
    flaky: [],
    problems: [],
    unhandled: { known: [], blocking: [] },
    elapsedMs: 4200,
    exitCode: 0,
    ...overrides
  })

  it('is quotable as gate 1 only for the whole suite', () => {
    expect(formatVerdict(verdict())).toBe(
      'Unit gate @abcdef1234 (clean): PASS — 3 passed; 1 failed (1 allowlisted, 0 unexpected); 0 flaky re-run passed; 0 unhandled error headline(s); 4 s'
    )
  })

  it('marks a forwarded selector as a subset run', () => {
    const line = formatVerdict(verdict({ selectors: ['src/a.test.ts'] }))
    expect(line).toContain('partial: -- src/a.test.ts')
    expect(line).toContain('NOT a gate-1 verdict')
  })

  it('says a dirty run is dirty, so a clean verdict cannot be quoted in its place', () => {
    expect(formatVerdict(verdict({ clean: false }))).toContain('(dirty): PASS')
  })
})

describe('what a flaky pass is allowed to waive', () => {
  it('reads every import spelling a test can use', () => {
    expect(
      importSpecifiers(
        [
          "import { a } from './a'",
          "export * from '../b'",
          "await import('./c')",
          "import './d'",
          "const e = require('./e')",
          "import x from 'react'"
        ].join('\n')
      )
    ).toEqual(['./a', '../b', './c', './d', './e', 'react'])
  })

  it('couples a test to its sibling module and to what it imports', () => {
    const paths = branchCoupledPaths(
      'src/main/foo.test.ts',
      () => "import { bar } from './bar'\nimport { baz } from '../shared/baz'\nimport 'react'"
    )
    expect(paths).toContain('src/main/foo.test.ts')
    expect(paths).toContain('src/main/foo.ts')
    expect(paths).toContain('src/main/bar.ts')
    expect(paths).toContain('src/shared/baz.ts')
    expect(paths.some((path) => path.startsWith('react'))).toBe(false)
  })

  it('resolves the renderer aliases a component test reaches for', () => {
    const paths = branchCoupledPaths(
      'src/renderer/src/foo.test.tsx',
      () => "import { Button } from '@renderer/components/ui/button'"
    )
    expect(paths).toContain('src/renderer/src/components/ui/button.tsx')
  })

  it('will not waive a branch that changed the module under test', () => {
    // The failure mode #150 named: `src/x.ts` changes, `x.test.ts` breaks only under load, and the
    // test file is not in the diff, so the old file-level waiver called it "not ours".
    expect(flakeWaiver('src/main/foo.test.ts', new Set(['src/main/foo.ts']), noSource)).toEqual({
      inDiff: true,
      matched: 'src/main/foo.ts'
    })
  })

  it('will not waive a branch that changed a module the test imports', () => {
    const waiver = flakeWaiver(
      'tests/tools/gate-lint.test.mjs',
      new Set(['local/gate-lint.mjs']),
      () => "import { classifyRun } from '../../local/gate-lint.mjs'"
    )
    expect(waiver).toEqual({ inDiff: true, matched: 'local/gate-lint.mjs' })
  })

  it('will not waive a branch that changed the harness every test runs under', () => {
    // A pool, timeout or setup change reds a test that names none of it in its own imports.
    for (const shared of ['config/vitest.config.ts', 'pnpm-lock.yaml', 'package.json']) {
      expect(SHARED_TEST_INPUTS).toContain(shared)
      expect(flakeWaiver('src/main/foo.test.ts', new Set([shared]), noSource)).toEqual({
        inDiff: true,
        matched: shared
      })
    }
  })

  it('reads a build-only package.json change as no harness coupling', () => {
    // Why: the fork owns a permanent overlay in package.json, so a diff touching only build or lint
    // scripts was refusing every load flake — the test executes none of those scripts.
    const before = { scripts: { build: 'a', lint: 'b', test: 'vitest' }, dependencies: { x: '1' } }
    expect(
      packageJsonAffectsTests(before, {
        ...before,
        scripts: { ...before.scripts, build: 'z', lint: 'y' }
      })
    ).toBe(false)
    expect(
      flakeWaiver('src/main/foo.test.ts', new Set(['package.json']), noSource, {
        packageJsonShared: false
      })
    ).toEqual({ inDiff: false, matched: null })
  })

  it('reads a dependency or test-script change as harness coupling', () => {
    const before = { scripts: { test: 'vitest' }, dependencies: { x: '1' } }
    expect(packageJsonAffectsTests(before, { ...before, dependencies: { x: '2' } })).toBe(true)
    expect(
      packageJsonAffectsTests(before, { ...before, scripts: { test: 'vitest --changed' } })
    ).toBe(true)
    expect(packageJsonAffectsTests(before, { ...before, packageManager: 'pnpm@10' })).toBe(true)
  })

  it('follows what the config and the runner import, so the pool and sequencer are covered', () => {
    // A hand list missed exactly these the first time: re-seating tests into the node-runtime pool is
    // a harness change no test file mentions.
    for (const imported of [
      'config/scripts/vitest-runtime-sequencer.mjs',
      'config/scripts/vitest-node-runtime-files.mjs',
      'config/scripts/vitest-node-runtime-pool.ts'
    ]) {
      expect(sharedHarnessPaths()).toContain(imported)
      expect(flakeWaiver('src/main/foo.test.ts', new Set([imported]), noSource)).toEqual({
        inDiff: true,
        matched: imported
      })
    }
  })

  it('covers the files the config loads outside an import, and the package the runner imports', () => {
    // Neither is in the derived set: one is loaded through `createRequire(...)(…)`, the other is a
    // bare workspace specifier that resolves to a package directory.
    expect(
      flakeWaiver('src/main/foo.test.ts', new Set(['config/dark-build-switches.cjs']), noSource)
    ).toEqual({ inDiff: true, matched: 'config/dark-build-switches.cjs' })
    expect(
      flakeWaiver(
        'src/main/foo.test.ts',
        new Set(['src/packages/process-host/src/run-process.ts']),
        noSource
      )
    ).toEqual({ inDiff: true, matched: 'src/packages/process-host/' })
  })

  it('waives a flake nothing in the branch touches', () => {
    expect(
      flakeWaiver('src/main/foo.test.ts', new Set(['src/main/unrelated.ts']), noSource)
    ).toEqual({ inDiff: false, matched: null })
  })

  it('never waives when the branch diff could not be resolved', () => {
    expect(flakeWaiver('src/main/foo.test.ts', null, noSource)).toEqual({
      inDiff: true,
      matched: null
    })
  })
})

describe('the diff that judges a flaky pass', () => {
  function fakeGit(answers) {
    return (args) => answers[args.join(' ')] ?? null
  }

  it('uses the merge-base against the release line when that diff has content', () => {
    const run = fakeGit({
      'merge-base nplez1/main HEAD': 'base',
      'diff --name-only --no-renames base HEAD': 'src/a.ts'
    })
    expect(branchDiff(run)).toEqual({ base: 'nplez1/main', files: new Set(['src/a.ts']) })
  })

  it('does not read an empty release-line diff as resolved, and judges the merge instead', () => {
    // The sync shape: the merge lands *on* nplez1/main, so merge-base is HEAD, the diff is empty,
    // and the merge's own contribution is the only diff that can judge it.
    const run = fakeGit({
      'merge-base nplez1/main HEAD': 'head',
      'merge-base origin/nplez1/main HEAD': 'head',
      'diff --name-only --no-renames head HEAD': '',
      'rev-list --parents -n 1 HEAD': 'head first second',
      'diff --name-only --no-renames first HEAD': 'src/b.ts'
    })
    expect(branchDiff(run)).toEqual({ base: 'first', files: new Set(['src/b.ts']) })
  })

  it('answers unknown when there is nothing but HEAD itself to compare against', () => {
    const run = fakeGit({
      'merge-base nplez1/main HEAD': 'head',
      'merge-base origin/nplez1/main HEAD': 'head',
      'diff --name-only --no-renames head HEAD': '',
      'rev-list --parents -n 1 HEAD': 'head'
    })
    expect(branchDiff(run)).toBeNull()
  })

  it('judges a squashed land on the release line by its own single parent', () => {
    // Every PR into nplez1/main squashes, so a landed change is a one-parent commit that IS the line:
    // its diff against nplez1/main is empty. Reading that as `unknown` means "in the diff", which
    // refuses every flake on code the commit never touched.
    const run = fakeGit({
      'merge-base nplez1/main HEAD': 'head',
      'merge-base origin/nplez1/main HEAD': 'head',
      'diff --name-only --no-renames head HEAD': '',
      'rev-list --parents -n 1 HEAD': 'head first',
      'diff --name-only --no-renames first HEAD': 'src/c.ts'
    })
    expect(branchDiff(run)).toEqual({ base: 'first', files: new Set(['src/c.ts']) })
  })

  it('still answers unknown when a single-parent HEAD changed nothing itself', () => {
    const run = fakeGit({
      'merge-base nplez1/main HEAD': 'head',
      'merge-base origin/nplez1/main HEAD': 'head',
      'diff --name-only --no-renames head HEAD': '',
      'rev-list --parents -n 1 HEAD': 'head first',
      'diff --name-only --no-renames first HEAD': ''
    })
    expect(branchDiff(run)).toBeNull()
  })
})
