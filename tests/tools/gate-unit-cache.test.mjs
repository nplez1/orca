// The verdict cache: which recorded verdict may be reused, which may be recorded, and which revision a
// cached verdict governs. Real git repositories throughout — the neutral walk reads commit history, so a
// stubbed `git` would prove nothing about it.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cachedVerdictPath,
  cachedVerdictProblem,
  gateInputsFingerprint,
  governingCachedVerdict,
  lintVerdictProblem,
  resolvedGateCacheDir,
  unitGateCacheDir,
  verdictRecordProblem
} from '../../local/gate-verdict-cache.mjs'
import { writeLintVerdict } from '../../local/gate-lint-verdict.mjs'
import { tempGitRepo } from '../../local/sync/lib/temp-git-repo.mjs'

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

  // Why: a verdict keyed by exact revision was voided by the manifest commit that follows a review, so
  // a 25-minute suite re-ran to certify a revision no code in it had changed.
  it('reuses a verdict on a docs-only ancestor, and refuses one whose code moved', () => {
    const ancestor = { ...cached, revision: 'b'.repeat(40) }
    expect(
      cachedVerdictProblem(ancestor, {
        ...context,
        behind: ['local/sync/release-review/abc.json', 'RELEASE-RUNBOOK.md']
      })
    ).toBeNull()
    expect(cachedVerdictProblem(ancestor, { ...context, behind: ['src/main/a.ts'] })).toMatch(
      /does not name this revision/
    )
    expect(cachedVerdictProblem(ancestor, { ...context, behind: [] })).toMatch(
      /does not name this revision/
    )
  })

  // Why: a doc committed during the run (session entry #709) voided a completed run and cost the re-run.
  it('records a run a docs commit followed, and still refuses one whose code moved', () => {
    const later = { headNow: 'b'.repeat(40), treeClean: true }
    expect(verdictRecordProblem(options, completed, { ...later, behind: ['NOTES.md'] })).toBeNull()
    expect(
      verdictRecordProblem(options, completed, { ...later, behind: ['src/main/a.ts'] })
    ).toMatch(/HEAD moved/)
    expect(verdictRecordProblem(options, completed, { ...later, behind: null })).toMatch(
      /HEAD moved/
    )
    expect(
      verdictRecordProblem(options, completed, { ...later, behind: ['NOTES.md'], treeClean: false })
    ).toMatch(/tree changed/)
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

/**
 * Why this rule is worth a test: a wrong "neutral" answer certifies a revision no suite ran on, and the
 * class it must absorb is narrow — docs and the review's own record, nothing that a test can execute.
 */
describe('which cached verdict governs a revision', () => {
  const repos = []
  afterEach(() => {
    for (const repo of repos.splice(0)) {
      repo.remove()
    }
  })

  const repoWith = (files) => {
    const repo = tempGitRepo('orca-gate-cache-')
    repos.push(repo)
    // Why the adapter: the fixture's `git` is variadic, and the lookups take an argv array.
    return { repo, git: (args) => repo.git(...args), first: repo.commit('code', files) }
  }

  const cacheFor = (repo, revision, verdict = {}) => {
    // Why inside `.git`: that is where gate-unit writes it, and a cache beside the worktree would be
    // committed by the next `git add -A` and read as a code change.
    const cacheDir = join(repo.dir, '.git', 'orca-gate')
    mkdirSync(cacheDir, { recursive: true })
    const recorded = { revision, clean: true, exitCode: 0, gateInputs: 'inputs', ...verdict }
    writeFileSync(cachedVerdictPath(cacheDir, revision, 'fp'), JSON.stringify(recorded))
    return cacheDir
  }

  it('is governed by the verdict of the revision a docs commit followed', () => {
    const { repo, git, first } = repoWith({ 'src/a.ts': 'one\n' })
    const cacheDir = cacheFor(repo, first)
    const head = repo.commit('docs', { 'RELEASE-RUNBOOK.md': 'notes\n' })

    expect(governingCachedVerdict({ cacheDir, revision: head, fingerprint: 'fp', git })).toEqual({
      verdict: expect.objectContaining({ revision: first }),
      behind: ['RELEASE-RUNBOOK.md']
    })
    expect(governingCachedVerdict({ cacheDir, revision: first, fingerprint: 'fp', git })).toEqual({
      verdict: expect.objectContaining({ revision: first }),
      behind: []
    })
  })

  it('is not governed by it once code changed after it', () => {
    const { repo, git, first } = repoWith({ 'src/a.ts': 'one\n' })
    const cacheDir = cacheFor(repo, first)
    const head = repo.commit('fix', { 'src/a.ts': 'two\n' })

    expect(governingCachedVerdict({ cacheDir, revision: head, fingerprint: 'fp', git })).toBeNull()
  })

  it('answers null for a revision this repository does not have', () => {
    const { repo, git, first } = repoWith({ 'src/a.ts': 'one\n' })
    const cacheDir = cacheFor(repo, first)
    expect(
      governingCachedVerdict({ cacheDir, revision: 'e'.repeat(40), fingerprint: 'fp', git })
    ).toBeNull()
  })

  it('refuses lint on a failed marker, a missing marker, or code after a green one', () => {
    const { repo, git, first } = repoWith({ 'src/a.ts': 'one\n' })
    writeLintVerdict({
      gitCommonDir: join(repo.dir, '.git'),
      revision: first,
      steps: [{ id: 'lint:types', exitCode: 0 }]
    })
    const docs = repo.commit('docs', { 'NOTES.md': 'x\n' })
    const code = repo.commit('fix', { 'src/a.ts': 'two\n' })
    const at = (revision) =>
      lintVerdictProblem({ commonDir: join(repo.dir, '.git'), revision, git })

    expect(at(first)).toBeNull()
    expect(at(docs)).toBeNull()
    expect(at(code)).toContain('no green lint verdict')

    // Why by hand: `writeLintVerdict` only ever records a gate PASS (a known-red-only failure set is
    // one), so a failed marker is exactly what a damaged or older file looks like. The reader has to
    // refuse it, and nothing in this tool writes it.
    writeFileSync(
      join(repo.dir, '.git', 'orca-lint', `${code.slice(0, 12)}.json`),
      `${JSON.stringify({ revision: code, allPassed: false, failed: ['lint:types'] }, null, 2)}\n`
    )
    expect(at(code)).toContain('lint FAILED')
  })
})
