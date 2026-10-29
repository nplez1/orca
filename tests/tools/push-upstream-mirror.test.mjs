import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MIRROR_PUSH, SWEEP, refusalsFor } from '../../local/sync/push-upstream-mirror.mjs'

const SCRIPT = new URL('../../local/sync/push-upstream-mirror.mjs', import.meta.url).pathname
const REPO_ROOT = new URL('../../', import.meta.url).pathname
const dirs = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const run = (cwd, ...args) => spawnSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8' })

describe('the mirror push refuses to run half of itself', () => {
  it('pushes the one ref pair, atomically, and sweeps right after', () => {
    expect(MIRROR_PUSH).toEqual(['push', '--atomic', 'origin', 'upstream/main:main'])
    expect(SWEEP.join(' ')).toContain('local/check-actions-enablement.mjs --fix')
  })

  it('refuses without both remotes, naming which one is missing', () => {
    const problems = refusalsFor({ remotes: ['origin'], hasUpstreamMain: true })

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("no 'upstream' remote")
  })

  it('refuses a checkout other than the one it lives in, so the sweep cannot land elsewhere', () => {
    const problems = refusalsFor({
      remotes: ['origin', 'upstream'],
      hasUpstreamMain: true,
      toplevel: '/somewhere/else',
      root: '/here'
    })

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('the checkout this script lives in')
  })

  it('refuses when upstream/main was never fetched', () => {
    expect(refusalsFor({ remotes: ['origin', 'upstream'], hasUpstreamMain: false })[0]).toContain(
      'git fetch upstream'
    )
  })

  it('passes when both remotes exist and upstream/main resolves', () => {
    expect(refusalsFor({ remotes: ['origin', 'upstream'], hasUpstreamMain: true })).toEqual([])
  })
})

describe('running it', () => {
  it('prints the plan, pushes nothing, and reports what is on now', () => {
    const result = run(REPO_ROOT, '--dry-run')

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('git push --atomic origin upstream/main:main')
    expect(result.stdout).toContain('check-actions-enablement.mjs --fix')
    // The report-only half actually ran, which is what makes --dry-run worth having.
    expect(result.stdout).toContain('check-actions:')
  })

  it('exits 2 before pushing when run from another checkout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirror-push-'))
    dirs.push(dir)
    spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' })

    const result = run(dir)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('refusing')
    expect(result.stdout).not.toContain('pushing')
  })
})
