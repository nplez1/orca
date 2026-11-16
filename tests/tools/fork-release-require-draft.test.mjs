import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readWorkflow } from './workflow-file.mjs'

const SCRIPT = new URL('../../.github/scripts/fork-release-require-draft.sh', import.meta.url)
  .pathname
const RELEASE = readWorkflow('.github/workflows/fork-release.yml')
const dirs = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Runs the script for real against a fake `gh` that answers `isDraft` with `answer`. */
function run(answer, args = ['nplez1/orca', 'v1.2.3-np.7']) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-require-draft-'))
  dirs.push(dir)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'gh'),
    [
      '#!/usr/bin/env bash',
      'case "$FAKE_ANSWER" in',
      '  missing) echo "release not found" >&2; exit 1 ;;',
      '  error) echo "HTTP 401: Bad credentials" >&2; exit 1 ;;',
      '  *) echo "$FAKE_ANSWER" ;;',
      'esac',
      ''
    ].join('\n')
  )
  chmodSync(join(bin, 'gh'), 0o755)
  try {
    const stdout = execFileSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_ANSWER: answer,
        RUNNER_TEMP: dir
      }
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return { status: error.status, stdout: String(error.stdout), stderr: String(error.stderr) }
  }
}

describe('a leg uploads only into its own draft', () => {
  it('accepts a draft', () => {
    const result = run('true')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('is a draft')
  })

  it('refuses a published release, where electron-builder would skip the upload and pass', () => {
    const result = run('false')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('already published')
  })

  it('refuses a missing release, where electron-builder would create its own', () => {
    const result = run('missing')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('has no release')
    expect(result.stderr).toContain('not --failed')
  })

  it('refuses when gh cannot answer, rather than reading it as either', () => {
    const result = run('error')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('cannot read release')
  })

  it('refuses an answer that is not a literal true', () => {
    expect(run('').status).toBe(1)
  })

  it('is a usage error without a repository and a tag', () => {
    expect(run('true', ['nplez1/orca']).status).toBe(2)
  })

  it('runs in every leg, immediately before electron-builder publishes', () => {
    for (const leg of ['macos', 'windows', 'linux']) {
      const steps = RELEASE.jobs[leg].steps
      const check = steps.findIndex((step) =>
        (step.run ?? '').includes('fork-release-require-draft.sh')
      )
      const upload = steps.findIndex((step) => (step.run ?? '').includes('--publish always'))

      expect(check, leg).toBeGreaterThan(-1)
      expect(upload - check, leg).toBe(1)
    }
  })
})
