import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = new URL('../../', import.meta.url)
const SCRIPT = new URL('.github/scripts/fork-release-ref-guard.sh', ROOT).pathname
const WORKFLOW = new URL('.github/workflows/fork-release.yml', ROOT).pathname
const dirs = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * The guard runs for real, against a fake `gh` and a throwaway git repo. Why not a text match on the
 * workflow: the two things that went wrong here were both logic — a ref nobody compared, and a
 * `targetCommitish` resolved as a branch name, which always equals this run's commit.
 */
function scenario({ target, tagCommit = null, tag = 'v1.2.3-np.7' }) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-release-guard-'))
  dirs.push(dir)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'gh'),
    [
      '#!/usr/bin/env bash',
      'if [ "$FAKE_GH_ERROR" = "1" ]; then',
      '  echo "HTTP 401: Bad credentials (https://api.github.com/graphql)" >&2',
      '  exit 1',
      'fi',
      'if [ "$FAKE_RELEASE_TARGET" = "missing" ]; then',
      '  echo "release not found" >&2',
      '  exit 1',
      'fi',
      'echo "$FAKE_RELEASE_TARGET"',
      ''
    ].join('\n')
  )
  chmodSync(join(bin, 'gh'), 0o755)
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q', '.')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 't')
  writeFileSync(join(dir, 'package.json'), '{}\n')
  git('add', '-A')
  git('commit', '-qm', 'base')
  const sha = git('rev-parse', 'HEAD')
  let other = null
  if (tagCommit === 'other') {
    writeFileSync(join(dir, 'next.txt'), 'x\n')
    git('add', '-A')
    git('commit', '-qm', 'other')
    other = git('rev-parse', 'HEAD')
    git('tag', tag, other)
    git('reset', '-q', '--hard', sha)
  } else if (tagCommit === 'here') {
    git('tag', tag)
  }
  const run = (args) => {
    const releaseTarget = target === 'sha' ? sha : (target ?? 'missing')
    try {
      const stdout = execFileSync('bash', [SCRIPT, ...args], {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          FAKE_RELEASE_TARGET: releaseTarget,
          FAKE_GH_ERROR: target === 'error' ? '1' : '0',
          RUNNER_TEMP: dir
        }
      })
      return { status: 0, stdout, stderr: '' }
    } catch (error) {
      return { status: error.status, stdout: String(error.stdout), stderr: String(error.stderr) }
    }
  }
  return { run, sha, other, tag }
}

describe('the release dispatch guard', () => {
  it('refuses any ref but the fork release line', () => {
    const { run, sha, tag } = scenario({ ref: 'refs/heads/audit-210', target: 'missing' })
    const result = run(['refs/heads/audit-210', tag, sha, 'nplez1/orca'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('dispatched from refs/heads/nplez1/main')
  })

  it('creates the tag when the release does not exist yet', () => {
    const { run, sha, tag } = scenario({ target: 'missing' })
    const result = run(['refs/heads/nplez1/main', tag, sha, 'nplez1/orca'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('does not exist yet')
  })

  it('accepts a re-dispatch onto the commit the tag names', () => {
    const { run, sha, tag } = scenario({ target: 'sha' })
    const result = run(['refs/heads/nplez1/main', tag, sha, 'nplez1/orca'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('already exists')
  })

  it('refuses a tag that points at another commit, whatever the release records', () => {
    // The measured hole: the old check printed "uploading into it" and replaced the assets of a
    // release whose tag and notes pointed at the previous revision.
    const { run, sha, tag, other } = scenario({ target: 'branch', tagCommit: 'other' })
    const result = run(['refs/heads/nplez1/main', tag, sha, 'nplez1/orca'])
    expect(sha).not.toBe(other)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('would replace its assets')
  })

  it('resolves a branch-named target to the tag, never to this run’s checkout', () => {
    // electron-builder records the branch it published from. Resolving that name against the
    // checkout always equals GITHUB_SHA, which accepted a re-dispatch from any commit on the branch.
    const here = scenario({ target: 'nplez1/main', tagCommit: 'here' })
    expect(here.run(['refs/heads/nplez1/main', here.tag, here.sha, 'nplez1/orca']).status).toBe(0)

    const elsewhere = scenario({ target: 'nplez1/main', tagCommit: 'other' })
    expect(
      elsewhere.run(['refs/heads/nplez1/main', elsewhere.tag, elsewhere.sha, 'nplez1/orca']).status
    ).toBe(1)
  })

  it('refuses when the tag is not in this checkout, rather than assuming it matches', () => {
    const { run, sha, tag } = scenario({ target: 'nplez1/main', tagCommit: null })
    const result = run(['refs/heads/nplez1/main', tag, sha, 'nplez1/orca'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`not ${sha}`)
  })

  it('tells a gh failure apart from a missing release', () => {
    const { run, sha, tag } = scenario({ target: 'error' })
    const result = run(['refs/heads/nplez1/main', tag, sha, 'nplez1/orca'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('cannot read release')
  })

  it('is a usage error to run it without a tag or repository', () => {
    const { run } = scenario({ target: 'missing' })
    expect(run(['refs/heads/nplez1/main']).status).toBe(2)
  })

  it('is what the workflow runs, before any platform builds', async () => {
    const { readFileSync } = await import('node:fs')
    const workflow = readFileSync(WORKFLOW, 'utf8')
    const preflight = workflow.slice(workflow.indexOf('  release-ref:'))
    expect(preflight).toContain('bash .github/scripts/fork-release-ref-guard.sh')
    expect(preflight).toContain('"$GITHUB_REF"')
    const jobBlock = (name) => {
      const start = workflow.indexOf(`\n  ${name}:\n`)
      const rest = workflow.slice(start + 1)
      const next = rest.search(/\n {2}[a-z][\w-]*:\n/)
      return next === -1 ? rest : rest.slice(0, next)
    }
    // A guard any leg can start ahead of is not a guard: the legs build and upload the artifacts.
    expect(jobBlock('macos')).toMatch(/\n {4}needs: release-ref\n/)
    expect(jobBlock('windows')).toMatch(/\n {4}needs: macos\n/)
    expect(jobBlock('linux')).toMatch(/\n {4}needs: windows\n/)
    expect(workflow.indexOf('release-ref:')).toBeLessThan(workflow.indexOf('macos:'))
  })
})
