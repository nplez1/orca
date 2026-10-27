import { describe, expect, it } from 'vitest'
import {
  SHARED_TEST_INPUTS,
  branchCoupledPaths,
  flakeWaiver,
  importSpecifiers,
  sharedHarnessPaths
} from '../../local/gate-flake-coupling.mjs'
import {
  cachedVerdictProblem,
  formatVerdict,
  gateInputsFingerprint,
  unitGateCacheDir,
  verdictRecordProblem
} from '../../local/gate-verdict-cache.mjs'
import { branchDiff } from '../../local/gate-unit.mjs'
import {
  declaredUnhandledMismatch,
  unexplainedSuiteExit
} from '../../local/unit-gate-judgement.mjs'

const noSource = () => ''

describe('a run the report cannot explain fails closed', () => {
  it('passes a clean exit', () => {
    expect(
      unexplainedSuiteExit({ outcome: 'complete', status: 0, failedCount: 0, unhandledCount: 0 })
    ).toBeNull()
  })

  it('passes a non-zero exit that a failure or an unhandled error accounts for', () => {
    const base = { outcome: 'complete', status: 1, failedCount: 39, unhandledCount: 0 }
    expect(unexplainedSuiteExit(base)).toBeNull()
    expect(unexplainedSuiteExit({ ...base, failedCount: 0, unhandledCount: 1 })).toBeNull()
  })

  it('fails a non-zero exit with nothing behind it', () => {
    expect(
      unexplainedSuiteExit({ outcome: 'complete', status: 1, failedCount: 0, unhandledCount: 0 })
    ).toMatch(/exited 1 .*failing closed/)
    expect(
      unexplainedSuiteExit({ outcome: 'complete', status: null, failedCount: 0, unhandledCount: 0 })
    ).toMatch(/without a status/)
  })

  it('fails a suite that never finished, whatever it managed to print', () => {
    expect(
      unexplainedSuiteExit({
        outcome: 'timed-out',
        status: null,
        failedCount: 0,
        unhandledCount: 0
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
})
