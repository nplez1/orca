import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Upstream's `max-lines` ratchet reports a new bypass and expects a human to allow it. The fork's rule
// (LOCAL-PATCHES.md § local(lint)) is narrower than that: only an upstream-owned file may be exempted,
// because splitting one costs a permanent hunk on every sync, while the fork's own files must be
// split. That half is checkable, so it is checked here rather than left to a reviewer's memory.
const BASELINE = 'config/max-lines-baseline.txt'
const UPSTREAM_REF = 'origin/main'
const KINDS = new Set(['inline', 'mobile-config'])

export function parseBaseline(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const [kind, path] = line.split(/\s+/)
      return { kind, path }
    })
}

function refExists(ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      stdio: 'ignore'
    })
    return true
  } catch {
    return false
  }
}

// The upstream mirror is `origin/main` here; `origin/HEAD` is the fallback for a clone that renamed it.
// Tried in order rather than assuming one, because a silent skip is how a policy check stops checking.
function resolveUpstreamRef() {
  for (const ref of [UPSTREAM_REF, 'origin/HEAD']) {
    if (refExists(ref)) {
      return ref
    }
  }
  return null
}

function existsAtRef(path, ref) {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}:${path}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const entries = parseBaseline(readFileSync(BASELINE, 'utf8'))
const upstreamRef = resolveUpstreamRef()

describe('max-lines baseline', () => {
  it('parses every row into a known kind and a path', () => {
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(KINDS.has(entry.kind), `unknown kind in: ${entry.kind} ${entry.path}`).toBe(true)
      expect(entry.path, `row without a path: ${entry.kind}`).toBeTruthy()
    }
  })

  it('names files that exist in this tree, so a renamed file cannot leave a stale row', () => {
    for (const entry of entries) {
      const tracked = execFileSync('git', ['ls-files', '--error-unmatch', entry.path], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
      expect(tracked.trim()).toBe(entry.path)
    }
  })

  it.skipIf(upstreamRef === null)(
    'exempts only upstream-owned files (the sync base is the upstream mirror)',
    () => {
      const forkOwned = entries.filter((entry) => !existsAtRef(entry.path, upstreamRef))
      expect(
        forkOwned.map((entry) => entry.path),
        'a fork-owned file over the max-lines budget must be split, not exempted: it has no upstream ' +
          'copy to conflict with, so the cap is a free guard there (LOCAL-PATCHES.md § local(lint))'
      ).toEqual([])
    }
  )
})
