import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classifyRun,
  extractFailureLines,
  FORK_LINT_STEPS,
  matchesEntry,
  resolveGateSteps,
  resolveLintSteps
} from '../../local/gate-lint.mjs'

const REPO_ROOT = join(import.meta.dirname, '..', '..')

const SCRIPTS = {
  lint: 'oxlint && node config/scripts/check-thing.mjs && pnpm run check:other-ratchet',
  'check:other-ratchet': 'node config/scripts/check-other-ratchet.mjs'
}

describe('the lint chain is read from package.json, not restated', () => {
  it('keeps the order and names each step the way `pnpm lint` does', () => {
    expect(resolveLintSteps(SCRIPTS)).toEqual([
      { id: 'oxlint', command: 'oxlint', argv: ['pnpm', 'exec', 'oxlint'] },
      {
        id: 'check-thing',
        command: 'node config/scripts/check-thing.mjs',
        argv: ['node', 'config/scripts/check-thing.mjs']
      },
      {
        id: 'check:other-ratchet',
        command: 'pnpm run check:other-ratchet',
        argv: ['pnpm', 'run', 'check:other-ratchet']
      }
    ])
  })

  it('refuses a chain that names a script package.json does not have', () => {
    expect(() => resolveLintSteps({ lint: 'pnpm run missing' })).toThrow(/missing/)
  })
})

describe('fork-only steps run from the gate, not from package.json', () => {
  const forkStep = {
    id: 'check-thing',
    command: 'node config/scripts/check-thing.mjs',
    argv: ['node', 'config/scripts/check-thing.mjs']
  }

  // Why against the real tree: this is the only place the identity check runs locally now, so a
  // gate that stopped resolving it would otherwise go quiet rather than red.
  it('runs the fork identity check on this repository', () => {
    const { scripts } = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
    expect(resolveGateSteps(scripts).map((step) => step.id)).toContain(
      'check-upstream-identity-literals'
    )
    expect(FORK_LINT_STEPS.map((step) => step.id)).toContain('check-upstream-identity-literals')
  })

  it('runs a fork step once when a sync puts it back into the chain', () => {
    const steps = resolveGateSteps({
      lint: 'oxlint && node config/scripts/check-upstream-identity-literals.mjs'
    })
    const ids = steps.map((step) => step.id)
    expect(ids.filter((id) => id === 'check-upstream-identity-literals')).toHaveLength(1)
    // The pnpm-shaped fork steps have no chain entry to duplicate, so they ride along once each.
    expect(ids).toEqual([
      'oxlint',
      'check-upstream-identity-literals',
      'check:process-host-imports',
      'check:workspace-path-sync-fs-ratchet',
      'check:compat-boundary-imports'
    ])
  })

  it('refuses a fork step whose script is gone instead of skipping it', () => {
    expect(() =>
      resolveGateSteps({ lint: 'oxlint' }, [forkStep], join(REPO_ROOT, 'no-such-root'))
    ).toThrow(/check-thing/)
  })
})

describe('the consolidated run-lint runner is expanded, not collapsed', () => {
  it('runs the steps run-lint.mjs runs, not one opaque step', () => {
    const { scripts } = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
    const ids = resolveGateSteps(scripts).map((step) => step.id)
    expect(ids).not.toContain('run-lint')
    expect(ids).toEqual(expect.arrayContaining(['oxlint', 'check:import-boundaries']))
  })

  // Why: collapsing to one step is the failure this guards — it passes green while attributing
  // nothing, so a reworded runner has to throw rather than quietly merge 36 steps into one.
  it('refuses a runner it cannot read steps out of', () => {
    const root = mkdtempSync(join(tmpdir(), 'lint-gate-runner-'))
    mkdirSync(join(root, 'config', 'scripts'), { recursive: true })
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { lint: 'node config/scripts/run-lint.mjs' } })
    )
    writeFileSync(join(root, 'config', 'scripts', 'run-lint.mjs'), 'export const OTHER = []\n')
    expect(() => resolveGateSteps({ lint: 'node config/scripts/run-lint.mjs' }, [], root)).toThrow(
      /LINT_STEPS/
    )
  })
})

describe('failure lines inside one step', () => {
  it('reads an entry ratchet as one line per offending entry', () => {
    const output = [
      '::error::New id-only-store-write entry not allowed: RepoLifecycleOps.relocateRepoPath',
      '',
      'Take the row, not its id: RepoHostTarget …',
      '::error::New id-only-store-write entry not allowed: lookup:a.ts#b'
    ].join('\n')
    expect(extractFailureLines(output)).toEqual([
      'New id-only-store-write entry not allowed: RepoLifecycleOps.relocateRepoPath',
      'New id-only-store-write entry not allowed: lookup:a.ts#b'
    ])
  })

  it('reads a count ratchet row, grown and shrunk alike', () => {
    const output = [
      'src/main/a.ts: 2 raw repo connectionId read(s), baseline allows 0.',
      'src/main/b.ts: now 0, baseline 4.',
      'The baseline may only shrink.'
    ].join('\n')
    expect(extractFailureLines(output)).toEqual([
      'src/main/a.ts: 2 raw repo connectionId read(s), baseline allows 0.',
      'src/main/b.ts: now 0, baseline 4.'
    ])
  })

  it('keeps the file a workflow command names, so two files do not collapse into one line', () => {
    const output = [
      '::error file=src/a.ts::1 focus read(s), baseline allows 0.',
      '::error file=src/b.ts::1 focus read(s), baseline allows 0.',
      '::error file=src/a.ts,line=15,title=typescript(x)::Do not use any type assertions.'
    ].join('\n')
    expect(extractFailureLines(output)).toEqual([
      'src/a.ts: 1 focus read(s), baseline allows 0.',
      'src/b.ts: 1 focus read(s), baseline allows 0.',
      'src/a.ts: Do not use any type assertions.'
    ])
  })

  it('finds no line in prose, so an unparseable failure falls back to the step', () => {
    expect(extractFailureLines('Cannot find module oxlint\n')).toEqual([])
  })
})

const entry = (overrides) => ({
  step: 'check:other-ratchet',
  class: 'host-toolchain',
  owner: 'upstream',
  ...overrides
})

describe('the verdict a run produces', () => {
  it('passes when every failing step is a known red', () => {
    const verdict = classifyRun(
      [
        { id: 'oxlint', exitCode: 0, output: '' },
        { id: 'check:other-ratchet', exitCode: 1, output: '::error::entry a' }
      ],
      [entry({ match: '^entry a$' })]
    )
    expect(verdict.unexpected).toEqual([])
    expect(verdict.known).toHaveLength(1)
    expect(verdict.staleEntries).toEqual([])
  })

  it('fails a new entry in a step whose baseline allows a different one', () => {
    const verdict = classifyRun(
      [{ id: 'check:other-ratchet', exitCode: 1, output: '::error::entry a\n::error::entry b' }],
      [entry({ match: '^entry a$' })]
    )
    expect(verdict.known.map((row) => row.line)).toEqual(['entry a'])
    expect(verdict.unexpected).toEqual([{ step: 'check:other-ratchet', line: 'entry b' }])
  })

  it('allows a whole step only when the entry names no line', () => {
    const whole = entry({})
    expect(matchesEntry('anything at all', whole)).toBe(true)
    expect(matchesEntry('anything at all', entry({ match: '^entry a$' }))).toBe(false)
    const verdict = classifyRun(
      [{ id: 'check:other-ratchet', exitCode: 1, output: 'a wall of compiler text' }],
      [whole]
    )
    expect(verdict.known).toHaveLength(1)
    expect(verdict.unexpected).toEqual([])
  })

  it('reports a step that failed without any parseable line, so a crash is never allowed', () => {
    const verdict = classifyRun(
      [{ id: 'check:other-ratchet', exitCode: 1, output: 'Cannot find module oxlint\n' }],
      [entry({ match: '^entry a$' })]
    )
    expect(verdict.unexpected).toEqual([
      { step: 'check:other-ratchet', line: 'Cannot find module oxlint' }
    ])
  })

  it('will not let a match entry cover the whole step through the fallback line', () => {
    // The fallback stands for output the parser could not split, so a pattern that happens to match
    // its last line must not allow every other failure in that step with it.
    const verdict = classifyRun(
      [{ id: 'check:other-ratchet', exitCode: 1, output: 'wall of text\nDone in 8s\n' }],
      [entry({ match: '^Done in 8s$' })]
    )
    expect(verdict.known).toEqual([])
    expect(verdict.unexpected).toEqual([{ step: 'check:other-ratchet', line: 'Done in 8s' }])
    expect(verdict.staleEntries).toHaveLength(0)
  })

  it('never lets a timed-out step read as known from the output it managed to print', () => {
    // A killed step reported nothing complete, so an allowlisted line it printed first must not
    // stand in for the verdict it never reached.
    const verdict = classifyRun(
      [{ id: 'check:other-ratchet', exitCode: 1, output: '::error::entry a\n', timedOut: true }],
      [entry({ match: '^entry a$' })]
    )
    expect(verdict.known).toEqual([])
    expect(verdict.unexpected).toEqual([
      { step: 'check:other-ratchet', line: 'timed out before it finished reporting' }
    ])
    expect(verdict.staleEntries).toEqual([])
  })

  it('judges an entry for a missing step against the whole chain, not the steps this run took', () => {
    const entries = [entry({ step: 'check:other-ratchet' }), entry({ step: 'check:gone-ratchet' })]
    const only = classifyRun(
      [{ id: 'check:other-ratchet', exitCode: 1, output: '::error::entry a' }],
      entries,
      ['check:other-ratchet', 'check:gone-ratchet']
    )
    // --only ran one step; the other step still exists, so its entry is not a stale step.
    expect(only.staleSteps).toEqual([])
    expect(
      classifyRun([], entries, ['check:other-ratchet']).staleSteps.map((row) => row.step)
    ).toEqual(['check:gone-ratchet'])
  })

  it('calls an entry that stopped reproducing stale, and one for a missing step stale too', () => {
    const verdict = classifyRun(
      [{ id: 'check:other-ratchet', exitCode: 0, output: '' }],
      [entry({ match: '^entry a$' }), entry({ step: 'check:gone-ratchet' })]
    )
    expect(verdict.staleEntries.map((row) => row.step)).toEqual(['check:other-ratchet'])
    expect(verdict.staleSteps.map((row) => row.step)).toEqual(['check:gone-ratchet'])
  })
})
