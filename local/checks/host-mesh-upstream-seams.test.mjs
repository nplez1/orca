// Why: a CI checkout is the pull request's merge commit and fetches no branch ref, and it has no upstream
// remote either — the register's base and its ownership ruler both have to answer from what such a clone
// carries, or the step is red for a missing ref (or, worse, green because it measured nothing).
//
//   node --test local/checks/host-mesh-upstream-seams.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { SYNC_BASE_RECORD, fetchCommandFor } from '../lib/upstream-sync-base.mjs'
import { tempGitRepo } from '../sync/lib/temp-git-repo.mjs'
import { measureSurface, resolveBase } from './host-mesh-upstream-seams.mjs'

function recordSyncBase(repo, base) {
  const file = path.join(repo.dir, SYNC_BASE_RECORD)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ base }))
}

/** A fixture whose HEAD is a pull request's merge commit, over a trunk only a local branch names. */
function pullRequestRepo(repo) {
  const trunk = repo.commit('fork main', { 'src/upstream.ts': 'export const upstream = 1\n' })
  repo.git('checkout', '-q', '-b', 'feature')
  repo.commit('the feature', {
    'src/upstream.ts': 'export const upstream = 1\nexport const mine = 2\n'
  })
  repo.git('checkout', '-q', 'main')
  repo.git('merge', '-q', '--no-ff', '-m', 'Merge the feature', 'feature')
  return trunk
}

function withEventName(name, run) {
  const previous = process.env.GITHUB_EVENT_NAME
  process.env.GITHUB_EVENT_NAME = name
  try {
    return run()
  } finally {
    if (previous === undefined) {
      delete process.env.GITHUB_EVENT_NAME
    } else {
      process.env.GITHUB_EVENT_NAME = previous
    }
  }
}

test('a pull request merge commit is its own base, so no branch ref has to exist', () => {
  const repo = tempGitRepo('orca-seams-')
  try {
    const trunk = pullRequestRepo(repo)
    assert.equal(
      withEventName('pull_request', () => resolveBase([], repo.dir)),
      trunk
    )
  } finally {
    repo.remove()
  }
})

test('the recorded sync base decides ownership where the clone has no upstream ref', () => {
  const repo = tempGitRepo('orca-seams-')
  try {
    const base = repo.commit('upstream work', { 'src/upstream.ts': 'export const upstream = 1\n' })
    recordSyncBase(repo, base)
    repo.commit('the feature', {
      'src/upstream.ts': 'export const upstream = 1\nexport const mine = 2\n',
      'src/fork/own.ts': 'export const forkOwned = 1\n'
    })
    // The fork's own file is absent at the ruler, so it is the fork's and costs no seam.
    assert.deepEqual(measureSurface(base, repo.dir), [{ path: 'src/upstream.ts', lines: 1 }])
  } finally {
    repo.remove()
  }
})

test('a clone that can answer no ruler fails, naming the fetch that fixes it', () => {
  const repo = tempGitRepo('orca-seams-')
  try {
    const base = repo.commit('upstream work', { 'src/upstream.ts': 'export const upstream = 1\n' })
    assert.throws(
      () => measureSurface(base, repo.dir),
      /no upstream\/main and no recorded sync base/
    )
    const absent = 'b'.repeat(40)
    recordSyncBase(repo, absent)
    assert.throws(
      () => measureSurface(base, repo.dir),
      (error) => error.message.includes(fetchCommandFor(absent))
    )
  } finally {
    repo.remove()
  }
})
