import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const refspecs = (stdout) => stdout.split('\n').filter((line) => line.trim().length > 0)

describe('the tag mirror guard', () => {
  it('passes when the fork only needs new tags, and names the refspec to push', () => {
    const { origin, checkout } = pair({ origin: ['v1.0.0'], local: ['v1.0.0', 'v1.1.0'] })

    const result = guard(checkout, origin)

    expect(result.stdout.trim()).toBe('refs/tags/v1.1.0:refs/tags/v1.1.0')
    expect(result.stderr).toContain('1 tag(s) to add, 0 to move')
    expect(result.status).toBe(0)
  })

  it('sends only what it read, so a non-v* tag cannot ride along', () => {
    const { origin, checkout } = pair({ origin: [], local: ['v1.0.0', 'mobile-ios-v9.9.9'] })

    const result = guard(checkout, origin)

    expect(result.status).toBe(0)
    expect(refspecs(result.stdout)).toEqual(['refs/tags/v1.0.0:refs/tags/v1.0.0'])
  })

  it('counts a first run, when the fork has no v* tags at all', () => {
    const { origin, checkout } = pair({ origin: [], local: ['v1.0.0', 'v1.1.0'] })

    const result = guard(checkout, origin)

    expect(result.status).toBe(0)
    expect(refspecs(result.stdout)).toHaveLength(2)
    expect(result.stderr).toContain('2 tag(s) to add, 0 to move')
  })

  it('prints nothing to push when every tag is already mirrored', () => {
    const { origin, checkout } = pair({ origin: ['v1.0.0'], local: ['v1.0.0'] })

    const result = guard(checkout, origin)

    expect(result.status).toBe(0)
    expect(refspecs(result.stdout)).toEqual([])
    expect(result.stderr).toContain('0 tag(s) to add')
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
    expect(result.stderr).toContain('1 tag(s) to add')
  })

  it('compares annotated tags as tag objects, not as tag object against commit', () => {
    const { dir, checkout } = pair({ origin: [], local: [] })
    git(checkout, 'tag', '-a', 'v1.2.3', '-m', 'release')
    const origin = join(dir, 'annotated')
    git(dir, 'clone', '-q', checkout, origin)

    const result = guard(checkout, origin)

    expect(result.status).toBe(0)
    expect(refspecs(result.stdout)).toEqual([])
    expect(result.stderr).toContain('0 tag(s) to add, 0 to move')
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

  it('makes its temp files with a template GNU mktemp accepts', () => {
    // `mktemp -t name` is BSD-only: GNU mktemp (the runner) rejects a template without Xs, and under
    // `set -e` that exit is the whole job. This is the regression that would break the daily mirror.
    const source = readFileSync(GUARD, 'utf8')
    const templates = [...source.matchAll(/mktemp "([^"]+)"/g)].map((match) => match[1])

    expect(templates.length).toBeGreaterThan(0)
    for (const template of templates) {
      expect(template.endsWith('XXXXXX'), template).toBe(true)
    }
    expect(source).not.toContain('mktemp -t')
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

  it('guards before it pushes, and pushes only the refspecs the guard named', () => {
    expect(mirror).toContain('fork-tag-mirror-guard.sh origin')
    expect(mirror.indexOf('fork-tag-mirror-guard.sh')).toBeLessThan(mirror.indexOf('git push'))
    expect(mirror).toContain('git push --atomic origin $refspecs')
    // `--tags` would send every local tag, including the fork's own mobile-* ones, which start
    // App Store and Play builds.
    expect(mirror).not.toContain('--tags')
    expect(mirror).not.toContain('--force')
    expect(mirror).not.toContain('--mirror')
  })

  it('never fetches a branch: the mirror is tags only', () => {
    expect(mirror).toContain("git fetch --no-tags upstream '+refs/tags/v*:refs/tags/v*'")
  })
})
