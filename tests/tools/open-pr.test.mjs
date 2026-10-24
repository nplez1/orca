import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  allowlistFingerprint,
  cachedVerdictPath,
  unitGateCacheDir
} from '../../local/gate-verdict-cache.mjs'
import {
  FORK_OWNED_PATHS,
  REVIEW_CLAIM_EXAMPLE,
  TARGETS,
  allowlistAtHead,
  evaluateGates,
  forkOnlyPathsIn,
  forkOnlySubjects,
  localCommitsIn,
  parseArgs,
  parseGateWaivers,
  reviewClaim,
  unitGateVerdict
} from '../../local/open-pr.mjs'

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

function passingVerdict(overrides = {}) {
  return {
    revision: REVISION,
    clean: true,
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

it('passes gate 1 only on a cached PASS for this exact revision', () => {
  const { gitDir } = gateFixture(passingVerdict())

  const result = unitGateVerdict(REVISION, { gitDir, allowlistText: ALLOWLIST })
  expect(result.ok).toBe(true)
  expect(result.verdict.counts.passed).toBe(12378)
})

it('refuses gate 1 with no verdict, a failing verdict, a dirty verdict, or another revision', () => {
  const missing = gateFixture(null)
  expect(unitGateVerdict(REVISION, { ...missing, allowlistText: ALLOWLIST })).toMatchObject({
    ok: false,
    reason: expect.stringContaining('no cached unit-gate verdict')
  })

  const failing = gateFixture(
    passingVerdict({ exitCode: 1, unexpected: [{ file: 'src/x.test.ts', test: 'x' }] })
  )
  expect(unitGateVerdict(REVISION, { ...failing, allowlistText: ALLOWLIST })).toMatchObject({
    ok: false,
    reason: expect.stringContaining('gate 1 FAILED')
  })

  const dirty = gateFixture(passingVerdict({ clean: false }))
  expect(unitGateVerdict(REVISION, { ...dirty, allowlistText: ALLOWLIST })).toMatchObject({
    ok: false,
    reason: expect.stringContaining('dirty tree')
  })

  const otherRevision = gateFixture(passingVerdict({ revision: 'b'.repeat(40) }))
  expect(unitGateVerdict(REVISION, { ...otherRevision, allowlistText: ALLOWLIST })).toMatchObject({
    ok: false
  })
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

  expect(unitGateVerdict(REVISION, { gitDir, allowlistText: ALLOWLIST })).toMatchObject({
    ok: true
  })
  expect(unitGateVerdict(REVISION, { gitDir, allowlistText: permissive })).toMatchObject({
    ok: false
  })
})

it('refuses gate 1 when the commit has no allowlist to fingerprint', () => {
  expect(unitGateVerdict(REVISION, { gitDir: tempDir(), allowlistText: null })).toMatchObject({
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
    gateOne: { gitDir, allowlistText: ALLOWLIST }
  })

  expect(result.problems).toEqual([expect.stringContaining('needs a review claim')])
  expect(result.passes[0]).toContain('gate 1 PASS')

  const both = evaluateGates({
    waivers: new Map(),
    head: REVISION,
    body: 'Fixes #152\n',
    gateOne: { gitDir: tempDir(), allowlistText: ALLOWLIST }
  })
  expect(both.problems).toHaveLength(2)
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
