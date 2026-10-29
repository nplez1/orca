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

/**
 * A scratch fork (`origin`) and a checkout whose local tags stand in for what the mirror job just
 * fetched from upstream — the guard compares the local refs against the fork, because those are what
 * the push sends.
 */
function pair({ origin = [], local = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tag-mirror-'))
  dirs.push(dir)
  const seed = join(dir, 'seed')
  git(dir, 'init', '-q', seed)
  writeFileSync(join(seed, 'sha'), 'shared')
  git(seed, 'add', 'sha')
  git(seed, 'commit', '-q', '-m', 'first')
  const repo = (name, tags) => {
    const path = join(dir, name)
    git(dir, 'clone', '-q', seed, path)
    for (const tag of tags) {
      git(path, 'tag', tag)
    }
    return path
  }
  return { dir, origin: repo('origin', origin), checkout: repo('checkout', local) }
}

const guard = (cwd, ...args) => spawnSync('bash', [GUARD, ...args], { cwd, encoding: 'utf8' })

describe('the tag mirror guard', () => {
  it('passes when the fork only needs new tags', () => {
    const { origin, checkout } = pair({ origin: ['v1.0.0'], local: ['v1.0.0', 'v1.1.0'] })

    const result = guard(checkout, origin)

    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('1 tag(s) to add, 0 to move')
    expect(result.status).toBe(0)
  })

  it('refuses a tag the fork already publishes at another commit, naming both sides', () => {
    const { origin, checkout } = pair({ origin: ['v1.0.0'], local: [] })
    writeFileSync(join(checkout, 'sha'), 'a second commit')
    git(checkout, 'commit', '-q', '-am', 'second')
    git(checkout, 'tag', 'v1.0.0')

    const result = guard(checkout, origin)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('refusing to move v1.0.0')
    expect(result.stderr).toContain('nothing was pushed')
  })

  it('leaves a fork-only tag alone: the mirror only adds', () => {
    const { origin, checkout } = pair({ origin: ['v0.9.0-np.1'], local: ['v1.0.0'] })

    const result = guard(checkout, origin)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('1 tag(s) to add')
  })

  it('compares annotated tags as tag objects, not as tag object against commit', () => {
    const { dir, checkout } = pair({ origin: [], local: [] })
    git(checkout, 'tag', '-a', 'v1.2.3', '-m', 'release')
    const origin = join(dir, 'annotated')
    git(dir, 'clone', '-q', checkout, origin)

    const result = guard(checkout, origin)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('0 tag(s) to add, 0 to move')
  })

  it('refuses to push nothing, which is not a mirror', () => {
    const { origin, checkout } = pair({ origin: ['v1.0.0'], local: ['v9.9.9'] })
    git(checkout, 'tag', '-d', 'v9.9.9')

    const result = guard(checkout, origin)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('no v* tags to mirror')
  })

  it('fails closed when the fork cannot be read, instead of treating every tag as new', () => {
    const { dir, checkout } = pair({ origin: [], local: ['v1.0.0'] })

    const result = guard(checkout, join(dir, 'not-a-repository'))

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('cannot read tags from')
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
    expect(mirror).toContain('fork-tag-mirror-guard.sh origin')
    expect(mirror.indexOf('fork-tag-mirror-guard.sh')).toBeLessThan(mirror.indexOf('git push'))
    expect(mirror).toContain('git push --atomic origin --tags')
    expect(mirror).not.toContain('--force')
    expect(mirror).not.toContain('--mirror')
  })

  it('never fetches a branch: the mirror is tags only', () => {
    expect(mirror).toContain("git fetch --no-tags upstream '+refs/tags/v*:refs/tags/v*'")
  })
})
