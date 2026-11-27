import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classifyRun,
  entryProblem,
  extractFailureLines,
  FAST_LINT_STEPS,
  finalize,
  FORK_LINT_STEPS,
  matchesEntry,
  resolveGateSteps,
  resolveLintSteps,
  runSteps,
  unaccountedFailureLines
} from '../../local/gate-lint.mjs'
import { readLintVerdict, writeLintVerdict } from '../../local/gate-lint-verdict.mjs'
import { readWorkflow } from './workflow-file.mjs'

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

  // Why against the real tree: `--fast` rejects an unknown id the way `--only` does, so a step a sync
  // renamed would break the inner loop rather than shrink it — this catches that before an agent does.
  it('names only steps the gate resolves in its --fast subset', () => {
    const { scripts } = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
    const ids = new Set(resolveGateSteps(scripts).map((step) => step.id))
    expect(FAST_LINT_STEPS.filter((id) => !ids.has(id))).toEqual([])
    expect(new Set(FAST_LINT_STEPS).size).toBe(FAST_LINT_STEPS.length)
    expect(FAST_LINT_STEPS).toContain('check-upstream-file-comments')
  })

  it('runs the fork comment ratchet on this repository', () => {
    const { scripts } = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
    expect(resolveGateSteps(scripts).map((step) => step.id)).toContain(
      'check-upstream-file-comments'
    )
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
      'check-upstream-file-comments',
      'check-host-mesh-upstream-seams',
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

  it('allows a whole step only when the entry says so', () => {
    // `matchesEntry` answers only "does this line match this entry's pattern", so a whole-step entry has
    // no pattern to match and says so; `classifyRun` is what gives it the whole step.
    const whole = entry({ wholeStep: true })
    expect(matchesEntry('anything at all', whole)).toBe(false)
    expect(entryProblem(whole)).toBeNull()
    expect(matchesEntry('anything at all', entry({ match: '^entry a$' }))).toBe(false)
    const verdict = classifyRun(
      [{ id: 'check:other-ratchet', exitCode: 1, output: 'a wall of compiler text' }],
      [whole]
    )
    expect(verdict.known).toHaveLength(1)
    expect(verdict.unexpected).toEqual([])
    expect(verdict.entryProblems).toEqual([])
  })

  it('refuses an entry that names neither a line nor a whole step (#317)', () => {
    // Why: a missing `match` used to mean the broadest possible entry, so one forgotten field masked
    // every new failure in that step. The form has to be asked for.
    const accidental = entry({})
    expect(entryProblem(accidental)).toContain('neither a match nor wholeStep: true')
    const verdict = classifyRun(
      [{ id: 'check:other-ratchet', exitCode: 1, output: 'a wall of compiler text' }],
      [accidental]
    )
    // The step still fails on its own output; the entry problem is the second reason it must not pass.
    expect(verdict.unexpected).toHaveLength(1)
    expect(verdict.entryProblems).toHaveLength(1)
  })

  it('refuses an entry whose match is not a usable regex, and absorbs nothing', () => {
    expect(entryProblem(entry({ match: '(' }))).toContain('unusable match')
    expect(matchesEntry('x', entry({ match: '(' }))).toBe(false)
  })

  it('refuses an entry that names both a line and a whole step', () => {
    expect(entryProblem(entry({ match: '^entry a$', wholeStep: true }))).toContain(
      'the match does not apply'
    )
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

describe('a failure the parser could only partly attribute', () => {
  const astGrepRows = [
    'test-no-real-time-wait:src/renderer/src/components/right-sidebar/checks-list-expanded-details.test.tsx: 1 flaky-test finding(s), baseline allows 0.',
    'test-no-wall-clock:src/renderer/src/components/github/check-details-cache.test.ts: 4 flaky-test finding(s), baseline allows 0.',
    'Wait on the condition (expect.poll, vi.waitFor, locator assertions) instead of sleeping or',
    'polling, use fake timers or fixed timestamps instead of the wall clock, put',
    'A deliberate exception takes `// ast-grep-ignore: <rule-id> -- <reason>` above the line.'
  ].join('\n')

  const astGrepEntries = ['test-no-real-time-wait:', 'test-no-wall-clock:'].map((rule) =>
    entry({ step: 'lint:ast-grep-gates', match: `^${rule}` })
  )

  it('accepts a partly parsed step whose every failure line is allowlisted', () => {
    // The real output of `lint:ast-grep-gates` on this machine: two ratchet rows and its fix hint.
    const verdict = classifyRun(
      [{ id: 'lint:ast-grep-gates', exitCode: 1, output: astGrepRows }],
      astGrepEntries
    )
    expect(verdict.known).toHaveLength(2)
    expect(verdict.unexpected).toEqual([])
  })

  it('fails the same step when a lint diagnostic rides along beside the allowlisted rows', () => {
    // The hole this closes: the combined step runs the ast-grep lint scan too, and its diagnostics
    // are in no shape `extractFailureLines` reads, so they used to be skipped entirely.
    const verdict = classifyRun(
      [
        {
          id: 'lint:ast-grep-gates',
          exitCode: 1,
          output: `${astGrepRows}\nerror[no-explicit-any]: Do not use any type assertions.\n   ┌─ src/main/a.ts:12:3`
        }
      ],
      astGrepEntries
    )
    expect(verdict.known).toHaveLength(2)
    expect(verdict.unexpected).toEqual([
      {
        step: 'lint:ast-grep-gates',
        line: 'unattributed failure output: error[no-explicit-any]: Do not use any type assertions.'
      }
    ])
  })

  it('fails a step that crashed beside a row it managed to print', () => {
    const verdict = classifyRun(
      [
        {
          id: 'lint:ast-grep-gates',
          exitCode: 1,
          output: `::error::entry a\nError: spawn ast-grep ENOENT`
        }
      ],
      [entry({ step: 'lint:ast-grep-gates', match: '^entry a$' })]
    )
    expect(verdict.known).toHaveLength(1)
    expect(verdict.unexpected).toEqual([
      {
        step: 'lint:ast-grep-gates',
        line: 'unattributed failure output: Error: spawn ast-grep ENOENT'
      }
    ])
  })

  it('does not double-count a line it already extracted', () => {
    expect(
      unaccountedFailureLines('::error file=src/a.ts::1 focus read(s), baseline allows 0.', [
        'src/a.ts: 1 focus read(s), baseline allows 0.'
      ])
    ).toEqual([])
    expect(unaccountedFailureLines('panel note: nothing to do here')).toEqual([])
  })
})

// The 48-minute hang in #446: `pnpm run` puts the linter one level down, so a timeout aimed at the
// direct child left a grandchild holding the output pipe and the gate waited for a stream that could
// not close — with the step never named, because the gate printed a step only after it finished.

const FULL_SHA = '4f3a9c1e7b2d8a05c6e1f9b3d7a2c4e6f8b0d1a3'

/** Drive `finalize` with a real marker writer over a throwaway git common dir, and collect its output. */
async function recordPass(options = {}) {
  const gitCommonDir = mkdtempSync(join(tmpdir(), 'lint-gate-verdict-'))
  const lines = []
  const calls = []
  const out = async (line) => lines.push({ stream: 'out', line })
  const err = async (line) => lines.push({ stream: 'err', line })
  try {
    const code = await finalize(
      [{ id: 'oxlint', exitCode: 0, output: '', seconds: 1.5 }],
      [],
      ['oxlint'],
      {
        revision: FULL_SHA.slice(0, 7),
        fullRevision: FULL_SHA,
        out,
        err,
        // Why the real writer behind a spy: the call args are one claim, the file on disk is the other.
        recordVerdict: (verdict) => {
          calls.push(verdict)
          return writeLintVerdict({ ...verdict, gitCommonDir })
        },
        ...options
      }
    )
    return { code, calls, lines, marker: readLintVerdict(gitCommonDir, FULL_SHA) }
  } finally {
    rmSync(gitCommonDir, { recursive: true, force: true })
  }
}

describe('the verdict a full clean pass records', () => {
  it('writes a marker keyed by the full sha, while the label stays the short one', async () => {
    const { code, calls, lines, marker } = await recordPass()
    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0].revision).toBe(FULL_SHA)
    expect(marker?.revision).toBe(FULL_SHA)
    expect(marker.allPassed).toBe(true)
    expect(marker.steps).toEqual(['oxlint'])
    expect(lines.map(({ line }) => line)).toContainEqual(
      expect.stringContaining(`lint gate @${FULL_SHA.slice(0, 7)}: PASS`)
    )
  })

  // Why: the marker names a commit, and a tree with edits in it is not that commit.
  it('writes none when the tree is dirty', async () => {
    const { code, marker } = await recordPass({ dirty: true })
    expect(code).toBe(0)
    expect(marker).toBeNull()
  })

  // Why: a subset says nothing about the steps it skipped, so it cannot stand for the revision.
  it('writes none for an --only subset', async () => {
    const { code, marker } = await recordPass({ only: ['oxlint'] })
    expect(code).toBe(0)
    expect(marker).toBeNull()
  })

  // Why: a marker keyed by a short sha, or by `unknown` when git is unavailable, answers for nothing.
  it('writes none when the caller resolved no full sha', async () => {
    const { code, calls, marker } = await recordPass({ fullRevision: null })
    expect(code).toBe(0)
    expect(calls[0].revision).toBeNull()
    expect(marker).toBeNull()
  })

  it('writes none for a FAIL, which is not a verdict', async () => {
    const gitCommonDir = mkdtempSync(join(tmpdir(), 'lint-gate-verdict-'))
    const calls = []
    try {
      const code = await finalize(
        [{ id: 'oxlint', exitCode: 1, output: '::error::boom', seconds: 1 }],
        [],
        ['oxlint'],
        {
          revision: FULL_SHA.slice(0, 7),
          fullRevision: FULL_SHA,
          out: async () => {},
          err: async () => {},
          recordVerdict: (verdict) => calls.push(verdict)
        }
      )
      expect(code).toBe(1)
      expect(calls).toEqual([])
      expect(readLintVerdict(gitCommonDir, FULL_SHA)).toBeNull()
    } finally {
      rmSync(gitCommonDir, { recursive: true, force: true })
    }
  })
})

describe('the FAIL footer a reader can act on', () => {
  const knownEntry = entry({ step: 'check:known', match: '^entry a$' })
  const run = async (results) => {
    const lines = []
    const out = async (line) => lines.push({ stream: 'out', line })
    const err = async (line) => lines.push({ stream: 'err', line })
    const code = await finalize(
      results,
      [knownEntry],
      results.map((result) => result.id),
      { revision: 'abc1234', out, err }
    )
    return { code, lines: lines.map(({ stream, line }) => ({ stream, line })) }
  }
  const errLines = (lines) => lines.filter(({ stream }) => stream === 'err').map(({ line }) => line)

  it('names the new reds to re-run and the known reds apart from them', async () => {
    const { code, lines } = await run([
      { id: 'oxlint', exitCode: 0, output: '', seconds: 1 },
      { id: 'check:known', exitCode: 1, output: '::error::entry a', seconds: 1 },
      { id: 'check:new', exitCode: 1, output: '::error::entry b', seconds: 1 }
    ])
    const errors = errLines(lines)
    expect(code).toBe(1)
    expect(errors).toContain('re-run what failed: node local/gate-lint.mjs --only check:new')
    expect(errors).toContain('known reds (recorded, not a fix): check:known')
    // The ::error:: prefix is what the CI runner reads as a failure, so it stays.
    expect(errors).toContain('::error::new lint red check:new: entry b')
  })

  // Why: a step that carries both a known red and a new one is a step to re-run, not one to skip.
  it('re-runs a step that fails on a known red and a new one at once', async () => {
    const { lines } = await run([
      { id: 'check:known', exitCode: 1, output: '::error::entry a\n::error::entry b', seconds: 1 }
    ])
    expect(errLines(lines)).toContain(
      're-run what failed: node local/gate-lint.mjs --only check:known'
    )
  })

  it('puts a timed-out step in the re-run list, never among the known reds', async () => {
    const { lines } = await run([
      { id: 'check:known', exitCode: 1, output: '::error::entry a', seconds: 1 },
      { id: 'check:hang', exitCode: 1, output: 'step started', timedOut: true, seconds: 10 }
    ])
    const errors = errLines(lines)
    expect(errors).toContain('re-run what failed: node local/gate-lint.mjs --only check:hang')
    expect(errors).toContain('known reds (recorded, not a fix): check:known')
  })
})

// The 48-minute hang in #446: `pnpm run` puts the linter one level down, so a timeout aimed at the
// direct child left a grandchild holding the output pipe and the gate waited for a stream that could
// not close — with the step never named, because the gate printed a step only after it finished.
const HANGING_GRANDCHILD = `
process.on('SIGTERM', () => {})
// Why it prints its own pid: the test needs to prove *this* process died, and a line on the step's
// inherited stdout is also what kept the gate waiting for a pipe that could not close.
process.stdout.write(\`grandchild \${process.pid}\\n\`)
setInterval(() => {}, 1000)
`

const HANGING_STEP = `
import { spawn } from 'node:child_process'
// Why 'inherit': the grandchild then holds the step's stdout pipe, which is what kept the gate waiting.
spawn(process.execPath, [process.argv[2]], { stdio: ['ignore', 'inherit', 'inherit'] })
process.stdout.write('step started\\n')
setInterval(() => {}, 1000)
`

/** Poll for a pid to disappear: a killed process is reaped by its own parent, not by this test. */
async function goneWithin(pid, ms) {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise((done) => setTimeout(done, 25))
  }
  return false
}

describe('a step that hangs past its deadline (#446)', () => {
  const TIMEOUT_MS = 3000

  /** Why a fixture tree: the hang has to be reproducible without the real lint chain or a 10m wait. */
  const runHang = async () => {
    const root = mkdtempSync(join(tmpdir(), 'lint-gate-hang-'))
    const lines = []
    const out = async (line) => lines.push({ stream: 'out', line })
    const err = async (line) => lines.push({ stream: 'err', line })
    const step = {
      id: 'hang-fixture',
      command: `node ${join(root, 'step.mjs')}`,
      argv: [process.execPath, join(root, 'step.mjs'), join(root, 'grandchild.mjs')]
    }
    try {
      writeFileSync(join(root, 'grandchild.mjs'), HANGING_GRANDCHILD)
      writeFileSync(join(root, 'step.mjs'), HANGING_STEP)
      const results = await runSteps([step], { timeoutMs: TIMEOUT_MS, out, err })
      const code = await finalize(results, [], [step.id], { out, err })
      return { results, code, lines }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('kills the whole tree, names the step and fails the gate', async () => {
    const { results, code, lines } = await runHang()
    const [result] = results
    const grandchildPid = Number(/^grandchild (\d+)$/m.exec(result.output)?.[1])
    try {
      expect(result.timedOut).toBe(true)
      expect(result.id).toBe('hang-fixture')
      expect(result.seconds).toBeGreaterThanOrEqual(TIMEOUT_MS / 1000)
      expect(result.tail).toContain('step started')

      // The line that has to reach the log before the hang, not after it.
      const running = lines.find(({ line }) => line.startsWith('running [1/1] hang-fixture'))
      expect(running?.stream).toBe('out')
      expect(lines.indexOf(running)).toBe(0)

      // The timeout names the step in the CI log, with the output the step managed to print.
      const named = lines.filter(({ stream }) => stream === 'err').map(({ line }) => line)
      expect(named).toContainEqual(
        expect.stringContaining(
          `::error::lint step hang-fixture timed out after ${(TIMEOUT_MS / 1000).toFixed(1)}s`
        )
      )
      expect(named).toContainEqual(expect.stringContaining('| step started'))
      expect(named).toContainEqual(
        expect.stringContaining('::error::new lint red hang-fixture: timed out')
      )
      expect(code).toBe(1)

      // Why the grandchild and not the step's own exit: a kill that reaches only the direct child
      // leaves the grandchild holding the pipe, which is exactly the #446 hang.
      expect(grandchildPid).toBeGreaterThan(0)
      expect(await goneWithin(grandchildPid, 5000)).toBe(true)
    } finally {
      // Why: an assertion above must not leave a spinner behind on the box.
      try {
        process.kill(grandchildPid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
  })
})

describe('the CI step that runs the gate is bounded (#446)', () => {
  it('gives the lint verdict its own timeout, under the job bound', () => {
    const job = readWorkflow('.github/workflows/fork-main-gates.yml').jobs.gates
    const verdict = job.steps.find((step) => (step.run ?? '').includes('node local/gate-lint.mjs'))
    const bound = verdict?.['timeout-minutes']

    // Why not the literal: the number is the CI backstop's, and a step timeout that outlives the job
    // is not a step timeout — that relation is what has to hold, at any value the workflow chooses.
    expect(bound).toBeGreaterThan(0)
    expect(bound).toBeLessThan(job['timeout-minutes'])
  })
})
