// Why: a CI checkout is the pull request's merge commit and fetches no branch ref, and it has no upstream
// remote either — the register's base and its ownership ruler both have to answer from what such a clone
// carries, or the step is red for a missing ref (or, worse, green because it measured nothing).
//
//   node --test local/checks/host-mesh-upstream-seams.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { SYNC_BASE_RECORD, commitHasPath, fetchCommandFor } from '../lib/upstream-sync-base.mjs'
import { tempGitRepo } from '../sync/lib/temp-git-repo.mjs'
import {
  SEAMS,
  auditSurface,
  changedPaths,
  measureSurface,
  resolveBase,
  resolveStrict
} from './host-mesh-upstream-seams.mjs'

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

// Why end to end: the unit cases above prove the rule; this proves the wiring main() uses — changed paths decide
// strictness, the measured surface then fails an upstream file the feature's own diff did not declare, and a sync
// diff is exempt because its resolution rewrites feature files as a matter of course.
test('a hosts feature diff reds an undeclared upstream file; a sync diff does not', () => {
  const repo = tempGitRepo('orca-seams-diff-')
  try {
    const ruler = repo.commit('upstream work', { 'src/upstream.ts': 'export const upstream = 1\n' })
    recordSyncBase(repo, ruler)
    // Its own commit, so the record is not part of the diff under test.
    const base = repo.commit('record the sync base')

    const decide = () => {
      const paths = changedPaths(base, repo.dir)
      return resolveStrict(paths, {
        isUpstreamOwned: (changed) => commitHasPath(repo.dir, ruler, changed)
      })
    }

    repo.commit('the feature', {
      'src/shared/host-mesh/host-mesh-types.ts': 'export type Mesh = 1\n',
      'src/upstream.ts': 'export const upstream = 2\n'
    })
    const touched = measureSurface(base, repo.dir)
    assert.equal(decide(), true)
    assert.deepEqual(
      auditSurface(touched, { strict: decide() }).problems.map((line) => line.split(':')[0]),
      ['src/upstream.ts']
    )
    assert.deepEqual(auditSurface(touched).problems, [])

    repo.commit('the sync', {
      'src/shared/host-mesh/host-mesh-types.ts': 'export type Mesh = 3\n',
      // A sync moves the recorded base, which is what marks the diff as upstream work rather than this feature's.
      [SYNC_BASE_RECORD]: JSON.stringify({ base: 'a'.repeat(40) })
    })
    assert.equal(decide(), false)
  } finally {
    repo.remove()
  }
})

// Why: this register describes one feature's surface, and the lint gate runs it on every pull request, so an
// upstream file another feature's diff touches was failing every branch that fixes an upstream bug (#471).
test('a file the register does not name is a note, not a red', () => {
  const touched = [
    { path: 'src/renderer/src/store/slices/tabs/tabs-close-actions.ts', lines: 1 },
    { path: 'src/renderer/src/editor/diff/DiffViewer.tsx', lines: 4 }
  ]
  const lenient = auditSurface(touched)
  assert.deepEqual(lenient.problems, [])
  assert.equal(lenient.notes.length, 2)
  assert.deepEqual(
    auditSurface(touched, { strict: true }).problems.map((problem) => problem.split(':')[0]),
    touched.map((entry) => entry.path)
  )
})

// Why: without this the flag is dead code — nothing in CI passes --strict, so the feature's own sprawl would pass
// silently, which is the half of the guarantee the register exists for.
test("the hosts feature's own diff is strict without a flag, another feature's is not", () => {
  const upstreamOwned = (changed) => changed.endsWith('host-graph-heard-reports.ts')
  for (const path of [
    'src/main/host-mesh/host-mesh-driver.ts',
    'src/shared/host-mesh/host-mesh-types.ts',
    'src/main/ipc/host-graph/register.ts',
    'src/renderer/src/components/settings/runtime-environments/host-group/HostGroupSection.tsx',
    'src/cli/hosts/host-mesh-rpc.ts'
  ]) {
    assert.equal(resolveStrict([path]), true, path)
  }
  // A fork-absent-by-path-name file upstream does have is upstream's edit, not this feature's.
  assert.equal(
    resolveStrict(['src/main/host-graph/host-graph-heard-reports.ts'], {
      isUpstreamOwned: upstreamOwned
    }),
    false
  )
  const workspaceFix = ['src/renderer/src/store/slices/tabs/tabs-close-actions.ts']
  assert.equal(resolveStrict(workspaceFix), false)
  assert.equal(resolveStrict(workspaceFix, { strictFlag: true }), true)
})

// Why: a sync's diff is upstream's own work, and its resolution touches feature files routinely, so deriving
// strict from it would red the gate on the one branch nobody can fix — the sync itself.
test('a diff that moves the sync base never derives strict, but --strict still applies', () => {
  const syncDiff = ['src/shared/host-mesh/host-mesh-types.ts', SYNC_BASE_RECORD]
  assert.equal(resolveStrict(syncDiff), false)
  assert.equal(resolveStrict(syncDiff, { strictFlag: true }), true)
})

test('a declared seam past its budget fails with and without --strict', () => {
  const [seam] = SEAMS
  const touched = [{ path: seam.path, lines: seam.budget + 1 }]
  for (const options of [undefined, { strict: true }]) {
    const { problems } = auditSurface(touched, options)
    assert.equal(problems.length, 1)
    assert.match(problems[0], new RegExp(`budget of ${seam.budget} — `))
  }
  assert.deepEqual(auditSurface([{ path: seam.path, lines: seam.budget }]).problems, [])
})
