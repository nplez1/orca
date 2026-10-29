import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readWorkflow, runScripts } from './workflow-file.mjs'

const GUARD = new URL('../../.github/scripts/fork-tag-mirror-guard.sh', import.meta.url).pathname
const dirs = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8'
  })

/** A scratch origin (the fork) and upstream, both cloned from one seed so a shared tag is one commit. */
function pair({ origin = [], upstream = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tag-mirror-'))
  dirs.push(dir)
  const seed = join(dir, 'seed')
  git(dir, 'init', '-q', seed)
  writeFileSync(join(seed, 'sha'), 'shared')
  git(seed, 'add', 'sha')
  git(seed, 'commit', '-q', '-m', 'first')
  const clone = (name, tags) => {
    const path = join(dir, name)
    git(dir, 'clone', '-q', seed, path)
    for (const tag of tags) {
      git(path, 'tag', tag)
    }
    return path
  }
  return { dir, origin: clone('origin', origin), upstream: clone('upstream', upstream) }
}

const guard = (origin, upstream) =>
  spawnSync('bash', [GUARD, origin, upstream], { encoding: 'utf8' })

/** One more commit, so a tag can be moved onto it without touching history. */
function advance(path) {
  writeFileSync(join(path, 'sha'), `${Date.now()}-${Math.random()}`)
  git(path, 'add', 'sha')
  git(path, 'commit', '-q', '-m', 'second')
}

describe('the tag mirror guard', () => {
  it('passes when the fork only needs new tags', () => {
    const { origin, upstream } = pair({ origin: ['v1.0.0'], upstream: ['v1.0.0', 'v1.1.0'] })

    const result = guard(origin, upstream)

    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('1 tag(s) to add, 0 to move')
    expect(result.status).toBe(0)
  })

  it('refuses a tag the fork already publishes at another commit, naming both sides', () => {
    const { origin, upstream } = pair({ origin: ['v1.0.0'], upstream: ['v1.0.0'] })
    advance(upstream)
    git(upstream, 'tag', '-f', 'v1.0.0')

    const result = guard(origin, upstream)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('refusing to move v1.0.0')
    expect(result.stderr).toContain('nothing was pushed')
  })

  it('leaves a fork-only tag alone: the mirror only adds', () => {
    const { origin, upstream } = pair({ origin: ['v0.9.0-np.1'], upstream: ['v1.0.0'] })

    const result = guard(origin, upstream)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('1 tag(s) to add')
  })

  it('compares annotated tags as tag objects, not as tag object against commit', () => {
    const { dir, upstream } = pair({ origin: [], upstream: [] })
    git(upstream, 'tag', '-a', 'v1.2.3', '-m', 'release')
    const clone = join(dir, 'clone')
    git(dir, 'clone', '-q', upstream, clone)

    const result = guard(clone, upstream)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('0 tag(s) to add, 0 to move')
  })

  it('refuses to push an empty mirror, which is not a mirror', () => {
    const { origin, upstream } = pair({ origin: ['v1.0.0'], upstream: [] })

    const result = guard(origin, upstream)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('publishes no v* tags')
  })

  it('reports a usage error rather than silently passing', () => {
    expect(spawnSync('bash', [GUARD], { encoding: 'utf8' }).status).toBe(2)
  })
})

describe('the workflow that calls it', () => {
  const workflow = readWorkflow('.github/workflows/fork-upstream-tags.yml')
  // Comments are allowed to name the flags the commands must not use.
  const mirror = runScripts(workflow)
    .join('\n')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')

  it('guards before it pushes, and pushes without force', () => {
    expect(mirror).toContain('fork-tag-mirror-guard.sh origin upstream')
    expect(mirror.indexOf('fork-tag-mirror-guard.sh')).toBeLessThan(mirror.indexOf('git push'))
    expect(mirror).toContain('git push --atomic origin --tags')
    expect(mirror).not.toContain('--force')
    expect(mirror).not.toContain('--mirror')
  })

  it('never fetches a branch: the mirror is tags only', () => {
    expect(mirror).toContain("git fetch --no-tags upstream '+refs/tags/v*:refs/tags/v*'")
  })
})
