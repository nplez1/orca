import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkReleaseNotesBody,
  MIN_SUMMARY_BYTES
} from '../../.github/scripts/fork-release-notes-guard.mjs'

const SCRIPT = new URL('../../.github/scripts/fork-release-notes-guard.mjs', import.meta.url)
  .pathname
const dirs = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** The shape `fork-release-notes.mjs` writes: a summary heading, the prose, then the static sections. */
function generatedNotes(overrides = {}) {
  const heading = overrides.heading ?? '## What changed'
  const prose =
    overrides.prose ??
    '18 commits changed since the last release, including **4 fork patches** (`local(...)`). ' +
      'Changes are grouped by type below, newest first; a group that is capped says how many commits it left out.'
  return [
    heading,
    '',
    prose,
    '',
    '## Install',
    '',
    '| Platform | Artifact |',
    '| --- | --- |',
    '| macOS (Apple silicon) | `orca-macos-arm64.dmg` |',
    '| macOS (Intel) | `orca-macos-x64.dmg` |',
    '| Windows | `orca-windows-setup.exe` |',
    '| Linux | `orca-linux.AppImage` |',
    '',
    'This build is unsigned until `MAC_CERTS` exists, so macOS treats every release as a new app.',
    ''
  ].join('\n')
}

/** Run the guard for real: the exit code and the GitHub annotation are what the workflow acts on. */
function run(args, input) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      input
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return { status: error.status, stdout: String(error.stdout), stderr: String(error.stderr) }
  }
}

function withNotesFile(body) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-release-notes-guard-'))
  dirs.push(dir)
  const path = join(dir, 'notes.md')
  writeFileSync(path, body)
  return path
}

describe('the release notes guard', () => {
  it('accepts the generated body', () => {
    const result = run([withNotesFile(generatedNotes())])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('change summary')
  })

  it('accepts the first-release heading as well as the since-tag one', () => {
    for (const heading of ['## What changed', '## What changed since `v1.4.214-np.41`']) {
      expect(checkReleaseNotesBody(generatedNotes({ heading })).ok, heading).toBe(true)
    }
  })

  it('refuses the install-only body the workflow used to publish instead', () => {
    const path = withNotesFile('**Orca NP 1.4.214-np.42**\n\nBuilt from `abc123`.\n')
    const result = run([path])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('::error::refusing to publish')
    expect(result.stderr).toContain('no "## What changed" section')
  })

  it("refuses the generator's own fallback, which does carry the heading", () => {
    const fallback =
      '## What changed\n\n**A change summary could not be generated since `v1.4.214-np.41`:** it is ' +
      'derived from the commits in this build, and git history for that range is not available here. ' +
      "The commits are listed in the release's own comparison view, and the `fork-release.yml` run " +
      'log records the exact reason.\n'
    const result = run([withNotesFile(fallback)])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('fallback')
  })

  it('refuses a fragment shorter than a real summary', () => {
    const result = run([withNotesFile('## What changed\n\nThree fixes.\n')])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('under the 400')
  })

  it('refuses a missing file rather than passing an empty release body', () => {
    const result = run([join(tmpdir(), 'orca-release-notes-guard-does-not-exist.md')])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('cannot read')
  })

  it('reads the body from stdin, which is how the publish step checks the draft', () => {
    expect(run(['-'], generatedNotes()).status).toBe(0)
    const refused = run(['-'], '**Orca NP 1.4.214-np.42**\n\nBuilt from `abc123`.\n')
    expect(refused.status).toBe(1)
  })

  it('is a usage error to run it with nothing to read', () => {
    expect(run([]).status).toBe(2)
  })

  it('reports what it accepted, so the run log says which body went public', () => {
    const result = run(['-', '--label', 'the draft body of v1.4.214-np.41'], generatedNotes())
    expect(result.stdout).toContain('the draft body of v1.4.214-np.41')
    expect(MIN_SUMMARY_BYTES).toBe(400)
  })
})
