import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  GATE_INPUT_PATHS,
  allowlistFingerprint,
  cachedVerdictPath,
  gateInputsFingerprint,
  toolchainVersions,
  unitGateCacheDir
} from '../../local/gate-verdict-cache.mjs'
import {
  FORK_OWNED_PATHS,
  REVIEW_CLAIM_EXAMPLE,
  TARGETS,
  allowlistAtHead,
  changedPathsIn,
  derivedForkOwnedPaths,
  evaluateGates,
  forkOwnedPathsInRange,
  gateInputsAtHead,
  forkOnlyPathsIn,
  forkOnlySubjects,
  localCommitsIn,
  needsFullUnitGate,
  parseArgs,
  parseGateWaivers,
  unitGateVerdict
} from '../../local/open-pr.mjs'
import { reviewClaim, waiverDisclosure } from '../../local/pr-body-claims.mjs'

const SCRIPT = new URL('../../local/open-pr.mjs', import.meta.url).pathname
const REVISION = 'a'.repeat(40)
const ALLOWLIST = '{"entries":[]}\n'
const dirs = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-open-pr-'))
  dirs.push(dir)
  return dir
}

function gateFixture(verdict) {
  const gitDir = tempDir()
  if (verdict) {
    const cacheDir = unitGateCacheDir(gitDir)
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(
      cachedVerdictPath(cacheDir, REVISION, allowlistFingerprint(ALLOWLIST)),
      JSON.stringify(verdict)
    )
  }
  return { gitDir }
}

const TEST_INPUTS = 'test-gate-inputs'

function passingVerdict(overrides = {}) {
  return {
    revision: REVISION,
    clean: true,
    gateInputs: TEST_INPUTS,
    exitCode: 0,
    counts: { passed: 12378, failed: 11, known: 11 },
    unexpected: [],
    flaky: [],
    unhandled: { blocking: [] },
    elapsedMs: 1412000,
    ...overrides
  }
}

it('targets the fork by default and upstream only on request', () => {
  expect(TARGETS.fork).toMatchObject({
    repository: 'nplez1/orca',
    base: 'nplez1/main',
    remote: 'origin'
  })
  expect(TARGETS.upstream).toMatchObject({
    repository: 'stablyai/orca',
    base: 'main',
    remote: 'upstream'
  })
  expect(parseArgs(['--upstream']).upstream).toBe(true)
  expect(parseArgs([]).upstream).toBe(false)
})

it('collects a waiver per gate, and refuses one without a reason', () => {
  expect(parseArgs(['--waive-gate', '1:no suite on this box']).waiveGates).toEqual([
    '1:no suite on this box'
  ])

  const waivers = parseGateWaivers(['1:no suite on this box', '2:review pending'])
  expect(waivers.get(1)).toBe('no suite on this box')
  expect(waivers.get(2)).toBe('review pending')

  expect(() => parseGateWaivers(['1'])).toThrow(/<1\|2>:<reason>/)
  expect(() => parseGateWaivers(['3:not a gate'])).toThrow(/<1\|2>:<reason>/)
  expect(() => parseGateWaivers(['1:'])).toThrow(/<1\|2>:<reason>/)
})

it('accepts the review claim AGENTS.md asks for', () => {
  expect(reviewClaim(`${REVIEW_CLAIM_EXAMPLE}\n`)).toMatchObject({ ok: true })
  expect(reviewClaim('### Reviewed by Opus 5.5, high: round 2 delta clean')).toMatchObject({
    ok: true
  })
  expect(
    reviewClaim('- **Reviewed by** claude/opus, high: R1 (1 blocker fixed), clean on R2')
  ).toMatchObject({ ok: true })
  expect(reviewClaim('Reviewed by Opus 5.5, high: R1, 2 blockers addressed')).toMatchObject({
    ok: true
  })
})

it('refuses a review claim with no round, no closed verdict, or only a fenced example', () => {
  expect(reviewClaim('Reviewed by Opus 5.5, high: looks fine')).toMatchObject({
    ok: false,
    reason: expect.stringContaining('names no review round')
  })
  expect(reviewClaim('Reviewed by Opus 5.5, high: R1')).toMatchObject({
    ok: false,
    reason: expect.stringContaining('states no closed verdict')
  })
  // An open finding is not a verdict, which is what makes the gate worth having.
  expect(reviewClaim('Reviewed by Opus 5.5, high: R1 (3 blocking, unresolved)')).toMatchObject({
    ok: false,
    reason: expect.stringContaining('open finding')
  })
  expect(
    reviewClaim('Reviewed by Opus 5.5, high: R1 (3 blocking unresolved, 2 nits)')
  ).toMatchObject({ ok: false, reason: expect.stringContaining('open finding') })
  expect(reviewClaim('Reviewed by Opus 5.5, high: R1 not clean')).toMatchObject({
    ok: false,
    reason: expect.stringContaining('open finding')
  })
  expect(reviewClaim('Reviewed by nobody yet: R1 pending, findings TBD')).toMatchObject({
    ok: false
  })
  expect(
    reviewClaim(`Paste the line here:\n\n\`\`\`\n${REVIEW_CLAIM_EXAMPLE}\n\`\`\`\n`)
  ).toMatchObject({ ok: false, reason: expect.stringContaining('no "Reviewed by" line') })
  expect(reviewClaim('Fixes #152\n\nNo review yet.')).toMatchObject({
    ok: false,
    reason: expect.stringContaining('no "Reviewed by" line')
  })
})

it('finds a fork-only commit by its subject prefix', () => {
  const subjects = ['fix(git): a real fix', 'local(identity): ship as Orca NP', 'docs: notes']

  expect(forkOnlySubjects(subjects)).toEqual(['local(identity): ship as Orca NP'])
  expect(localCommitsIn('base..head', () => subjects.join('\n'))).toEqual([
    'local(identity): ship as Orca NP'
  ])
})

it('finds no fork-only commit on a clean upstream-bound branch', () => {
  expect(localCommitsIn('base..head', () => 'fix(git): a real fix\nfeat: another')).toEqual([])
})

it('finds a fork-owned path even when the commit that carried it is worded normally', () => {
  const changed = ['src/main/x.ts', 'local/open-pr.mjs', 'LOCAL-PATCHES.md']
  const fakeGit = (args) => {
    const pathspec = args.slice(args.indexOf('--') + 1).map((spec) => spec.replace(':(top)', ''))
    return changed
      .filter((path) =>
        pathspec.some((spec) => path === spec || (spec.endsWith('/') && path.startsWith(spec)))
      )
      .join('\n')
  }

  expect(forkOnlyPathsIn('base...head', fakeGit)).toEqual(['local/open-pr.mjs', 'LOCAL-PATCHES.md'])
  expect(FORK_OWNED_PATHS).toContain('LOCAL-PATCHES.md')
})

/** The fixtures record `TEST_INPUTS`, so the lookup is given the same value it would compute. */
function gateVerdict(head, options) {
  return unitGateVerdict(head, { gateInputs: TEST_INPUTS, ...options })
}

it('refuses a verdict recorded against different gate inputs', () => {
  // The same revision on a different bun or node is a different run of the machine-bound classes,
  // so a PASS recorded before the upgrade is not a verdict on this checkout.
  const { gitDir } = gateFixture(passingVerdict())
  expect(gateVerdict(REVISION, { gitDir, allowlistText: ALLOWLIST })).toMatchObject({ ok: true })
  expect(
    gateVerdict(REVISION, { gitDir, allowlistText: ALLOWLIST, gateInputs: 'other-inputs' })
  ).toMatchObject({ ok: false, reason: expect.stringContaining('different gate inputs') })
})

it('passes gate 1 only on a cached PASS for this exact revision', () => {
  const { gitDir } = gateFixture(passingVerdict())

  const result = gateVerdict(REVISION, { gitDir, allowlistText: ALLOWLIST })
  expect(result.ok).toBe(true)
  expect(result.verdict.counts.passed).toBe(12378)
})

it('refuses gate 1 with no verdict, a failing verdict, a dirty verdict, or another revision', () => {
  const missing = gateFixture(null)
  expect(gateVerdict(REVISION, { ...missing, allowlistText: ALLOWLIST })).toMatchObject({
    ok: false,
    reason: expect.stringContaining('no cached unit-gate verdict')
  })

  const failing = gateFixture(
    passingVerdict({ exitCode: 1, unexpected: [{ file: 'src/x.test.ts', test: 'x' }] })
  )
  expect(gateVerdict(REVISION, { ...failing, allowlistText: ALLOWLIST })).toMatchObject({
    ok: false,
    reason: expect.stringContaining('gate 1 FAILED')
  })

  const dirty = gateFixture(passingVerdict({ clean: false }))
  expect(gateVerdict(REVISION, { ...dirty, allowlistText: ALLOWLIST })).toMatchObject({
    ok: false,
    reason: expect.stringContaining('dirty tree')
  })

  const otherRevision = gateFixture(passingVerdict({ revision: 'b'.repeat(40) }))
  expect(gateVerdict(REVISION, { ...otherRevision, allowlistText: ALLOWLIST })).toMatchObject({
    ok: false
  })
})

it('fingerprints the gate inputs from the commit, byte for byte, as gate-unit does from the tree', () => {
  // The cross-reader bug this guards is the one already recorded for the allowlist: two scripts
  // hashing the same bytes differently means every fork PR looks like it has no verdict. Read from
  // the commit, like `allowlistAtHead`, so a work in progress does not fail the test.
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const files = {}
  for (const path of GATE_INPUT_PATHS) {
    // Why the catch: a gate input added on this branch is not in an earlier commit, and
    // `gateInputsAtHead` reads a path the commit lacks as empty rather than failing the lookup.
    try {
      files[path] = execFileSync('git', ['show', `${head}:${path}`], { encoding: 'utf8' })
    } catch {
      files[path] = ''
    }
  }
  expect(gateInputsAtHead(head)).toBe(
    gateInputsFingerprint({ files, toolchain: toolchainVersions() })
  )
})

it('hashes the committed allowlist with exactly the bytes gate-unit hashes', () => {
  // The two scripts must fingerprint the same bytes: `gate-unit` hashes readFileSync, so trimming the
  // `git show` output here silently moved every gate-1 lookup to a different cache file.
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const committed = execFileSync('git', ['show', `${head}:local/unit-known-red.json`], {
    encoding: 'utf8'
  })
  const working = readFileSync(new URL('../../local/unit-known-red.json', import.meta.url), 'utf8')

  expect(committed).toBe(working)
  expect(allowlistFingerprint(allowlistAtHead(head))).toBe(allowlistFingerprint(working))
})

it('fingerprints the allowlist in the commit, not the one in the working tree', () => {
  const { gitDir } = gateFixture(passingVerdict())
  // A permissive allowlist copied over the working-tree file changes no verdict for this revision.
  const permissive = '{"entries":[{"file":"src/x.test.ts"}]}\n'
  expect(permissive).not.toBe(ALLOWLIST)

  expect(gateVerdict(REVISION, { gitDir, allowlistText: ALLOWLIST })).toMatchObject({
    ok: true
  })
  expect(gateVerdict(REVISION, { gitDir, allowlistText: permissive })).toMatchObject({
    ok: false
  })
})

it('refuses gate 1 when the commit has no allowlist to fingerprint', () => {
  expect(gateVerdict(REVISION, { gitDir: tempDir(), allowlistText: null })).toMatchObject({
    ok: false,
    reason: expect.stringContaining('cannot read local/unit-known-red.json')
  })
})

it('refuses an upstream PR at gate 1 unless the exemption is recorded', () => {
  const refused = evaluateGates({
    upstream: true,
    head: REVISION,
    body: REVIEW_CLAIM_EXAMPLE
  })
  expect(refused.problems).toEqual([expect.stringContaining('gate 1 is fork-local')])

  const waived = evaluateGates({
    upstream: true,
    waivers: parseGateWaivers(['1:upstream PR, gated by upstream CI']),
    head: REVISION,
    body: REVIEW_CLAIM_EXAMPLE
  })
  expect(waived.problems).toEqual([])
  expect(waived.passes[0]).toContain('gate 2 PASS')
  expect(waived.waived).toEqual([[1, 'upstream PR, gated by upstream CI']])
})

it('reports both gates together, so one refusal does not hide the other', () => {
  const { gitDir } = gateFixture(passingVerdict())
  const result = evaluateGates({
    waivers: new Map(),
    head: REVISION,
    body: 'Fixes #152\n',
    gateOne: { gitDir, allowlistText: ALLOWLIST, gateInputs: TEST_INPUTS }
  })

  expect(result.problems).toEqual([expect.stringContaining('needs a review claim')])
  expect(result.passes[0]).toContain('gate 1 PASS')

  const both = evaluateGates({
    waivers: new Map(),
    head: REVISION,
    body: 'Fixes #152\n',
    gateOne: { gitDir: tempDir(), allowlistText: ALLOWLIST, gateInputs: TEST_INPUTS }
  })
  expect(both.problems).toHaveLength(2)
})

it('returns changed paths as an array, not newline-joined text', () => {
  // The caller that forgot this threw "changedPathsIn(...).split is not a function" on every run,
  // --dry-run included. Nothing here executes main(), so pin the contract the caller depends on.
  const result = changedPathsIn('base...head', () => 'src/main/a.ts\nlocal/open-pr.mjs\n\n')

  expect(Array.isArray(result)).toBe(true)
  expect(result).toEqual(['src/main/a.ts', 'local/open-pr.mjs'])
})

it('lists both sides of a rename, so a move out of src/shared still reads as global', () => {
  // A stub for the flag, and then the real behaviour, because the flag is only worth anything if
  // git actually reports the old path: `git diff` alone lists just the destination.
  const seen = []
  changedPathsIn('a...b', (args) => {
    seen.push(args)
    return 'src/shared/ipc.ts\nsrc/main/ipc.ts\n\n'
  })
  expect(seen[0]).toEqual(['diff', '--name-only', '--no-renames', 'a...b'])

  const repo = tempDir()
  const run = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  run('init', '-q', '.')
  run('config', 'user.email', 't@example.com')
  run('config', 'user.name', 't')
  mkdirSync(join(repo, 'src/shared'), { recursive: true })
  mkdirSync(join(repo, 'src/main'), { recursive: true })
  writeFileSync(join(repo, 'src/shared/ipc.ts'), 'x\n')
  run('add', '-A')
  run('commit', '-qm', 'base')
  run('mv', 'src/shared/ipc.ts', 'src/main/ipc.ts')
  run('add', '-A')
  run('commit', '-qm', 'move')

  const gitRun = (args) => run(...args)
  expect(changedPathsIn('HEAD~1...HEAD', gitRun)).toEqual(['src/main/ipc.ts', 'src/shared/ipc.ts'])
  expect(needsFullUnitGate(changedPathsIn('HEAD~1...HEAD', gitRun))).toMatchObject({
    required: true
  })
})

it('needs the full suite only when a changed path is global', () => {
  // Why these four groups: an ordinary change, a path that is in `src` but imported by every process,
  // a path that only documents or tests, and evidence that is missing rather than global.
  const targeted = [
    ['src/main/foo.ts', 'src/main/foo.test.ts'],
    ['src/renderer/src/a.tsx'],
    ['docs/STYLEGUIDE.md', 'AGENTS.md'],
    ['local/gate-unit.mjs', 'tests/tools/gate-unit.test.mjs'],
    ['.github/workflows/pr.yml']
  ]
  for (const paths of targeted) {
    expect(needsFullUnitGate(paths), paths.join(',')).toMatchObject({ required: false })
  }

  const global = [
    ['src/shared/ipc-contract.ts'],
    ['src/packages/process-host/src/index.ts'],
    ['package.json'],
    ['pnpm-lock.yaml'],
    ['config/vitest.config.ts'],
    ['tsconfig.node.json'],
    ['e2e/foo.ts'],
    ['scripts/build.mjs']
  ]
  for (const paths of global) {
    expect(needsFullUnitGate(paths), paths.join(',')).toMatchObject({ required: true })
  }

  // Why null and a rubbish element: an unreadable diff must not read as "nothing global changed".
  expect(needsFullUnitGate(null)).toMatchObject({ required: true })
  expect(needsFullUnitGate([])).toMatchObject({ required: true })
  expect(needsFullUnitGate([undefined])).toMatchObject({ required: true })
})

it('skips gate 1 for a targeted diff and names a global one when it refuses', () => {
  const skipped = evaluateGates({
    waivers: new Map(),
    head: REVISION,
    body: REVIEW_CLAIM_EXAMPLE,
    gateOne: { gitDir: tempDir(), allowlistText: ALLOWLIST, gateInputs: TEST_INPUTS },
    changedPaths: ['src/main/foo.ts', 'src/main/foo.test.ts']
  })
  expect(skipped.problems).toEqual([])
  expect(skipped.passes[0]).toContain('gate 1 not required')

  // Why the reason is appended: a refusal that says "no verdict" without saying "because this
  // touched package.json" sends the reader looking for a cache bug instead of a suite run.
  const refused = evaluateGates({
    waivers: new Map(),
    head: REVISION,
    body: REVIEW_CLAIM_EXAMPLE,
    gateOne: { gitDir: tempDir(), allowlistText: ALLOWLIST, gateInputs: TEST_INPUTS },
    changedPaths: ['package.json', 'src/main/foo.ts']
  })
  expect(refused.problems[0]).toContain('no cached unit-gate verdict')
  expect(refused.problems[0]).toContain('package.json')

  // And the same global diff still passes when the verdict is there.
  const { gitDir } = gateFixture(passingVerdict())
  const passed = evaluateGates({
    waivers: new Map(),
    head: REVISION,
    body: REVIEW_CLAIM_EXAMPLE,
    gateOne: { gitDir, allowlistText: ALLOWLIST, gateInputs: TEST_INPUTS },
    changedPaths: ['package.json']
  })
  expect(passed.problems).toEqual([])
  expect(passed.passes[0]).toContain('gate 1 PASS')
})

it('refuses a malformed waiver before it fetches anything', () => {
  const body = join(tempDir(), 'body.md')
  writeFileSync(body, 'Fixes #152\n')

  let failure = null
  try {
    execFileSync(
      'node',
      [SCRIPT, '--title', 'fix(fork): x', '--body-file', body, '--waive-gate', 'gate-one'],
      { cwd: tempDir(), encoding: 'utf8', stdio: 'pipe' }
    )
  } catch (error) {
    failure = error
  }

  expect(failure?.status).toBe(1)
  expect(String(failure?.stderr)).toContain('--waive-gate expects <1|2>:<reason>')
})

it('reads the body file it was given, not a fixed path', () => {
  const source = readFileSync(new URL('../../local/open-pr.mjs', import.meta.url), 'utf8')

  expect(source).toContain('mktemp')
  expect(source).not.toContain('/tmp/body.md')
})

it('refuses a review claim whose verdicts are still open', () => {
  // Every one of these was ACCEPTED by the previous regex, which is why gate 2 enforced nothing.
  for (const claim of [
    'Reviewed by Opus 5.5: R1 (3 blocking, not yet fixed)',
    'Reviewed by nobody: R1, will be fixed later',
    'Reviewed by Opus: R1 found 2 BLOCKERs; nits fixed',
    'Reviewed by Opus 5.5, high: R1 (3 blocking), R2 clean',
    'Reviewed by Opus 5.5, high: R1 (2 blocking fixed); R2 TBD',
    'Reviewed by Opus 5.5, high: R1 (2 blocking fixed), R2 unresolved'
  ]) {
    expect(reviewClaim(claim), claim).toMatchObject({ ok: false })
  }
})

it('names what a refused review claim is missing', () => {
  expect(reviewClaim('Reviewed by Opus 5.5: R1 (2 blocking fixed)')).toMatchObject({
    ok: false,
    reason: expect.stringContaining('Opus reviewer at high reasoning')
  })
  expect(reviewClaim('Reviewed by someone, high: R1 (2 blocking fixed)')).toMatchObject({
    ok: false,
    reason: expect.stringContaining('Opus reviewer')
  })
  expect(reviewClaim('Reviewed by Opus 5.5, high: R1 found 2 blockers')).toMatchObject({
    ok: false,
    reason: expect.stringContaining('without saying they were fixed')
  })
  expect(reviewClaim('Reviewed by Opus 5.5, high: R1 (2 blocking fixed), R2')).toMatchObject({
    ok: false,
    reason: expect.stringContaining('every round needs its own')
  })
  expect(reviewClaim('Reviewed by Opus 5.5, high: R1 (3 blocking, not yet fixed)')).toMatchObject({
    ok: false,
    reason: expect.stringContaining('open finding')
  })
})

it('refuses a claim whose blocker count is not closed by the same clause', () => {
  for (const claim of [
    // `clean` elsewhere in the line used to satisfy the round without closing these findings.
    'Reviewed by Opus 5.5, high: R1 found 2 blockers, everything else clean',
    // The closing verb is in the next clause, not this one.
    'Reviewed by Opus 5.5, high: R1 (2 blocking, 1 fixed)',
    // A count that says what is left open in another word.
    'Reviewed by Opus 5.5, high: R1 (2 blocking fixed, 1 deferred)',
    'Reviewed by Opus 5.5, high: R1 (2 blocking fixed), follow-up filed for the rest'
  ]) {
    expect(reviewClaim(claim), claim).toMatchObject({ ok: false })
  }
})

it('accepts the claim shapes a real review produces, including a delta round', () => {
  for (const claim of [
    REVIEW_CLAIM_EXAMPLE,
    'Reviewed by Opus 5.5, high: R1 (0 blocking fixed), delta clean on R2',
    'Reviewed by claude/opus, high: R1 (1 blocker fixed), clean on R2',
    'Reviewed by Opus 5.5, high: round 2 delta clean',
    'Reviewed by Opus 5.5, high: R1, 2 blockers addressed',
    'Reviewed by Opus 5.5, high: R1 (2 blocking fixed); R2 (1 blocking fixed), R3 clean',
    // AGENTS.md's own wording for a delta range: one round named twice is one round.
    'Reviewed by Opus 5.5, high: R1 (2 blocking fixed), delta R1..R2 clean'
  ]) {
    expect(reviewClaim(claim), claim).toMatchObject({ ok: true })
  }
})

it('requires the reviewer AGENTS.md names, version and reasoning included', () => {
  for (const claim of [
    'Reviewed by Opus 4, high: R1 clean',
    'Reviewed by Opus 5.5: R1 clean',
    'Reviewed by a strong model, high: R1 clean',
    'Reviewed by gpt-5, high: R1 clean'
  ]) {
    expect(reviewClaim(claim), claim).toMatchObject({ ok: false })
  }
})

it('writes a waiver into the body, because that is the only place a reader looks', () => {
  const waivers = new Map([
    [1, 'upstream PR, gated by upstream CI'],
    [2, 'no reviewer available']
  ])
  const written = waiverDisclosure('Fixes #210\n', waivers)
  expect(written.lines).toEqual([
    'Gate 1 waived: upstream PR, gated by upstream CI',
    'Gate 2 waived: no reviewer available'
  ])
  expect(written.body).toBe(
    'Fixes #210\n\nGate 1 waived: upstream PR, gated by upstream CI\nGate 2 waived: no reviewer available\n'
  )

  // Idempotent: a body that already states it is left alone, so a re-run adds no second copy.
  const stated = { body: written.body, lines: [] }
  expect(waiverDisclosure(written.body, waivers)).toEqual(stated)
  expect(waiverDisclosure('Fixes #210\n', new Map())).toEqual({ body: 'Fixes #210\n', lines: [] })
})

it('derives the fork-owned set from top-level trees upstream does not carry', () => {
  // Why top-level trees: a file-level derivation would refuse every new src/ file in an upstream PR
  // cut from work that has already landed on nplez1/main (BRANCHES.md), which is the normal shape
  // there. A whole tree upstream lacks is fork territory; a file inside src/ is not.
  const forkAdded = [
    '.agents/skills/electron/SKILL.md',
    'local/orca-vm/run.sh',
    'src/main/new-module.ts',
    'src/main/deepseek/new-provider.ts'
  ]
  const upstreamTop = ['src', '.github', 'docs', 'README.md']
  const fakeGit = (args) => {
    if (args[0] === 'rev-parse') {
      return args[3] === 'refs/remotes/origin/nplez1/main' ? null : 'refs/heads/nplez1/main'
    }
    if (args[0] === 'diff') {
      return forkAdded.join('\n')
    }
    if (args[0] === 'ls-tree') {
      return upstreamTop.join('\n')
    }
    return ''
  }
  expect(derivedForkOwnedPaths('base', fakeGit)).toEqual([
    '.agents/skills/electron/SKILL.md',
    'local/orca-vm/run.sh'
  ])
  // No fork line to compare against: the literal list is all that is left, which is not an error.
  expect(derivedForkOwnedPaths('base', () => null)).toBeNull()
})

it('refuses a branch that carries a fork directory nobody listed', () => {
  const changed = ['src/main/x.ts', 'tools/fork-only/thing.mjs']
  const fakeGit = (args) => {
    if (args[0] === 'rev-parse') {
      return args[3] === 'refs/remotes/origin/nplez1/main' ? 'refs/heads/nplez1/main' : null
    }
    if (args[0] === 'diff' && args.includes('--diff-filter=A')) {
      return ['tools/fork-only/thing.mjs', 'src/main/upstream-adds-this.ts'].join('\n')
    }
    if (args[0] === 'diff' && args.includes('--')) {
      // The literal list's pathspec run names nothing, which is the hole being closed.
      return ''
    }
    if (args[0] === 'diff') {
      return changed.join('\n')
    }
    if (args[0] === 'ls-tree') {
      return ['src', 'tests', 'README.md'].join('\n')
    }
    return ''
  }
  const paths = forkOwnedPathsInRange('base...head', 'base', fakeGit)
  expect(paths).toEqual(['tools/fork-only/thing.mjs'])
  // The trees the issue named are literal entries too, because a file inside a shared tree cannot be
  // derived: `.github/workflows/` exists upstream, `fork-*.yml` does not.
  for (const entry of [
    '.agents/skills/',
    '.github/workflows/fork-*.yml',
    '.github/scripts/fork-release-notes.mjs',
    'local/'
  ]) {
    expect(FORK_OWNED_PATHS).toContain(entry)
  }
})
