import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MIRROR_PUSH,
  SWEEP,
  judgeRun,
  refusalsFor
} from '../../local/sync/push-upstream-mirror.mjs'

const SCRIPT = new URL('../../local/sync/push-upstream-mirror.mjs', import.meta.url).pathname
const dirs = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const run = (cwd, ...args) => spawnSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8' })

describe('the mirror push refuses to run half of itself', () => {
  it('refuses without both remotes, naming which one is missing', () => {
    const problems = refusalsFor({ remotes: ['origin'], hasUpstreamMain: true })

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("no 'upstream' remote")
  })

  it('refuses when upstream/main was never fetched', () => {
    expect(refusalsFor({ remotes: ['origin', 'upstream'], hasUpstreamMain: false })[0]).toContain(
      'git fetch upstream'
    )
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

  it('passes when both remotes exist, upstream/main resolves, and it is the right checkout', () => {
    expect(
      refusalsFor({
        remotes: ['origin', 'upstream'],
        hasUpstreamMain: true,
        toplevel: '/here',
        root: '/here'
      })
    ).toEqual([])
  })
})

describe('what a run means', () => {
  it('is success only when the push landed and the sweep came back clean', () => {
    expect(judgeRun({ pushStatus: 0, sweepStatus: 0 }).code).toBe(0)
  })

  it('does not report a failed push as a swept fleet', () => {
    const verdict = judgeRun({ pushStatus: 128, sweepStatus: null })

    expect(verdict.code).toBe(1)
    expect(verdict.message).toContain('no sweep was attempted')
  })

  it('separates "the sweep drifted" from "the sweep could not tell"', () => {
    const drifted = judgeRun({ pushStatus: 0, sweepStatus: 1 })
    const unknown = judgeRun({ pushStatus: 0, sweepStatus: 2 })

    expect(drifted.code).toBe(1)
    expect(drifted.message).toContain('not clean')
    expect(unknown.code).toBe(2)
    expect(unknown.message).toContain('could not reach the API')
  })
})

describe('the script itself', () => {
  it('pushes the one ref pair, atomically, and sweeps with --fix right after', () => {
    const source = readFileSync(
      new URL('../../local/sync/push-upstream-mirror.mjs', import.meta.url),
      'utf8'
    )

    expect(MIRROR_PUSH).toEqual(['push', '--atomic', 'origin', 'upstream/main:main'])
    expect(SWEEP.join(' ')).toContain('local/check-actions-enablement.mjs --fix')
    // The constants are what the run uses, not a description of it.
    expect(source).toContain('spawnSync(SWEEP[0], SWEEP.slice(1)')
    expect(source).toContain("spawnSync('git', MIRROR_PUSH")
    expect(source.indexOf("spawnSync('git', MIRROR_PUSH")).toBeLessThan(
      source.indexOf('spawnSync(SWEEP[0]')
    )
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
