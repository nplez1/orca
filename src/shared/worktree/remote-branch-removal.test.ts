import { describe, expect, it } from 'vitest'
import {
  deleteRemoteBranchAfterLocalBranchRemoval,
  resolveRemoteBranchTarget
} from './remote-branch-removal'

/** What this clone last saw at the remote branch; the lease is made against it. */
const TRACKING_SHA = 'a'.repeat(40)

type Fixture = {
  /** `repoPath`-independent stand-in for `.git/config`. */
  config: Readonly<Record<string, string>>
  /** Refs that `rev-parse --verify`/`show-ref --verify` report as present. */
  refs: readonly string[]
  /** What `refs/remotes/<remote>/HEAD` points at, e.g. `origin/main`. Absent means unrecorded. */
  remoteHead?: string
  pushError?: Error
}

function makeRunner(fixture: Fixture): {
  runGit: (args: string[]) => Promise<{ stdout: string }>
  spawns: string[][]
} {
  const spawns: string[][] = []
  const runGit = async (args: string[]): Promise<{ stdout: string }> => {
    spawns.push(args)
    if (args[0] === 'config' && args[1] === '--get') {
      const value = fixture.config[args[2]]
      if (value === undefined) {
        throw Object.assign(new Error('config key is not set'), { code: 1 })
      }
      return { stdout: `${value}\n` }
    }
    if (args[0] === 'symbolic-ref') {
      if (fixture.remoteHead === undefined) {
        throw Object.assign(
          new Error('fatal: ref refs/remotes/origin/HEAD is not a symbolic ref'),
          {
            code: 128
          }
        )
      }
      return { stdout: `${fixture.remoteHead}\n` }
    }
    if (args[0] === 'rev-parse' || args[0] === 'show-ref') {
      const ref = args.at(-1) ?? ''
      if (!fixture.refs.includes(ref)) {
        throw Object.assign(new Error(`fatal: needed a single revision: ${ref}`), { code: 128 })
      }
      // A tracking ref reports a commit, which is what the delete's lease is built from.
      return { stdout: `${ref.startsWith('refs/remotes/') ? TRACKING_SHA : ref}\n` }
    }
    if (args[0] === 'remote' && args.length === 1) {
      return { stdout: '' }
    }
    if (args[0] === 'push') {
      if (fixture.pushError) {
        throw fixture.pushError
      }
      return { stdout: '' }
    }
    throw new Error(`unexpected git command: ${args.join(' ')}`)
  }
  return { runGit, spawns }
}

function pushedArgs(spawns: string[][]): string[][] {
  return spawns.filter((args) => args[0] === 'push')
}

const CONFIGURED_UPSTREAM = {
  'branch.feature.remote': 'origin',
  'branch.feature.merge': 'refs/heads/feature'
} as const

describe('resolveRemoteBranchTarget', () => {
  it('resolves the branch-configured upstream, not HEAD', async () => {
    const { runGit } = makeRunner({
      config: CONFIGURED_UPSTREAM,
      refs: ['refs/remotes/origin/feature']
    })

    const resolution = await resolveRemoteBranchTarget(runGit, 'feature')

    expect(resolution).toEqual({
      kind: 'resolved',
      target: { remoteName: 'origin', branchName: 'feature' }
    })
  })

  it('reports the remote branch name when it differs from the local one', async () => {
    const { runGit } = makeRunner({
      config: {
        'branch.local-name.remote': 'pr-contributor',
        'branch.local-name.merge': 'refs/heads/contributor/pushed-name'
      },
      refs: ['refs/remotes/pr-contributor/contributor/pushed-name']
    })

    const resolution = await resolveRemoteBranchTarget(runGit, 'local-name')

    // Reporting it is not permission to delete it: see `deleteRemoteBranchAfterLocalBranchRemoval`.
    expect(resolution).toEqual({
      kind: 'resolved',
      target: { remoteName: 'pr-contributor', branchName: 'contributor/pushed-name' }
    })
  })

  it('falls back to origin/<branch> when only the tracking ref exists', async () => {
    const { runGit } = makeRunner({ config: {}, refs: ['refs/remotes/origin/legacy'] })

    expect(await resolveRemoteBranchTarget(runGit, 'legacy')).toEqual({
      kind: 'resolved',
      target: { remoteName: 'origin', branchName: 'legacy' }
    })
  })

  it('reports no upstream when the branch tracks nothing', async () => {
    const { runGit } = makeRunner({ config: {}, refs: [] })

    expect(await resolveRemoteBranchTarget(runGit, 'feature')).toEqual({ kind: 'no-upstream' })
  })

  it.each(['-flag', 'has..dots', '', 'has\0nul'])(
    'refuses to target a remote branch named %j',
    async (branchName) => {
      const { runGit, spawns } = makeRunner({ config: CONFIGURED_UPSTREAM, refs: [] })

      expect(await resolveRemoteBranchTarget(runGit, branchName)).toEqual({ kind: 'no-upstream' })
      expect(spawns).toEqual([])
    }
  )
})

describe('deleteRemoteBranchAfterLocalBranchRemoval', () => {
  it('deletes the resolved remote branch under a lease once the local branch is gone', async () => {
    const { runGit, spawns } = makeRunner({
      config: CONFIGURED_UPSTREAM,
      refs: ['refs/remotes/origin/feature']
    })
    const target = await resolveRemoteBranchTarget(runGit, 'feature')

    const cleanup = await deleteRemoteBranchAfterLocalBranchRemoval({
      runGit,
      branchName: 'feature',
      target
    })

    expect(cleanup).toEqual({
      status: 'deleted',
      remoteName: 'origin',
      branchName: 'feature'
    })
    // The lease is the whole safety property: deleting a ref that moved since the last fetch would
    // discard commits pushed by someone else, which no local check can see.
    expect(pushedArgs(spawns)).toEqual([
      [
        'push',
        `--force-with-lease=refs/heads/feature:${TRACKING_SHA}`,
        'origin',
        ':refs/heads/feature'
      ]
    ])
  })

  // Why the empty lease and not a refusal: no tracking ref is also what a merged PR with GitHub's
  // auto-delete leaves behind, once `fetch --prune` has dropped the ref. An empty expectation succeeds
  // only when the ref does not exist, so a branch that is gone reports so and one that reappeared does
  // not get deleted on evidence nobody here has.
  it('leases an empty expectation when no tracking ref survives', async () => {
    const { runGit, spawns } = makeRunner({
      config: CONFIGURED_UPSTREAM,
      refs: [],
      pushError: new Error("error: unable to delete 'feature': remote ref does not exist")
    })
    const cleanup = await deleteRemoteBranchAfterLocalBranchRemoval({
      runGit,
      branchName: 'feature',
      target: {
        kind: 'resolved',
        target: { remoteName: 'origin', branchName: 'feature' }
      }
    })

    expect(cleanup).toEqual(
      expect.objectContaining({
        status: 'already-absent',
        remoteName: 'origin',
        branchName: 'feature'
      })
    )
    expect(pushedArgs(spawns)).toEqual([
      ['push', '--force-with-lease=refs/heads/feature:', 'origin', ':refs/heads/feature']
    ])
  })

  // The load-bearing safety rule: `git push --delete` has no merged-commit refusal, so a local
  // branch that survived removal (unmerged work, checked out elsewhere, pinned for preservation)
  // must keep its remote. Otherwise removal can discard the last copy of those commits.
  it.each([
    ['feature kept for unmerged commits', ['refs/heads/feature', 'refs/remotes/origin/feature']],
    ['feature checked out in another worktree', ['refs/heads/feature']]
  ])('leaves the remote alone while %s', async (_label, refs) => {
    const { runGit, spawns } = makeRunner({ config: CONFIGURED_UPSTREAM, refs })
    const target = await resolveRemoteBranchTarget(runGit, 'feature')

    const cleanup = await deleteRemoteBranchAfterLocalBranchRemoval({
      runGit,
      branchName: 'feature',
      target
    })

    expect(cleanup).toEqual({ status: 'skipped-preserved' })
    expect(pushedArgs(spawns)).toEqual([])
  })

  // A branch cut with `git checkout -b feat origin/develop` tracks `develop`, and a PR-review
  // worktree can track a contributor's fork: neither branch is one this workspace authored.
  it('refuses a remote branch whose name is not the local branch name', async () => {
    const { runGit, spawns } = makeRunner({
      config: {
        'branch.feat.remote': 'origin',
        'branch.feat.merge': 'refs/heads/develop'
      },
      refs: ['refs/remotes/origin/develop']
    })
    const target = await resolveRemoteBranchTarget(runGit, 'feat')

    const cleanup = await deleteRemoteBranchAfterLocalBranchRemoval({
      runGit,
      branchName: 'feat',
      target
    })

    expect(cleanup).toEqual({
      status: 'skipped-foreign-branch',
      remoteName: 'origin',
      branchName: 'develop'
    })
    expect(pushedArgs(spawns)).toEqual([])
  })

  it('refuses the remote default branch even when the names match', async () => {
    const { runGit, spawns } = makeRunner({
      config: {
        'branch.main.remote': 'origin',
        'branch.main.merge': 'refs/heads/main'
      },
      refs: ['refs/remotes/origin/main'],
      remoteHead: 'origin/main'
    })
    const target = await resolveRemoteBranchTarget(runGit, 'main')

    const cleanup = await deleteRemoteBranchAfterLocalBranchRemoval({
      runGit,
      branchName: 'main',
      target
    })

    expect(cleanup).toEqual({
      status: 'skipped-default-branch',
      remoteName: 'origin',
      branchName: 'main'
    })
    expect(pushedArgs(spawns)).toEqual([])
  })

  it('reports no-upstream without any local-branch probe when none resolved', async () => {
    const { runGit, spawns } = makeRunner({ config: {}, refs: [] })

    const cleanup = await deleteRemoteBranchAfterLocalBranchRemoval({
      runGit,
      branchName: 'feature',
      target: { kind: 'no-upstream' }
    })

    expect(cleanup).toEqual({ status: 'no-upstream' })
    expect(pushedArgs(spawns)).toEqual([])
  })

  it('treats a missing remote ref as already absent', async () => {
    const { runGit } = makeRunner({
      config: CONFIGURED_UPSTREAM,
      refs: ['refs/remotes/origin/feature'],
      pushError: new Error(
        "error: unable to delete 'feature': remote ref does not exist\nerror: failed to push some refs to 'origin'"
      )
    })
    const target = await resolveRemoteBranchTarget(runGit, 'feature')

    const cleanup = await deleteRemoteBranchAfterLocalBranchRemoval({
      runGit,
      branchName: 'feature',
      target
    })

    expect(cleanup).toEqual({
      status: 'already-absent',
      remoteName: 'origin',
      branchName: 'feature'
    })
  })

  it('leaves the branch alone when the remote moved past the last fetch', async () => {
    const { runGit } = makeRunner({
      config: CONFIGURED_UPSTREAM,
      refs: ['refs/remotes/origin/feature'],
      pushError: new Error(
        " ! [rejected]        (delete) -> feat (stale info)\nerror: failed to push some refs to 'origin'"
      )
    })
    const target = await resolveRemoteBranchTarget(runGit, 'feature')

    const cleanup = await deleteRemoteBranchAfterLocalBranchRemoval({
      runGit,
      branchName: 'feature',
      target
    })

    expect(cleanup).toEqual({
      status: 'skipped-changed-on-remote',
      remoteName: 'origin',
      branchName: 'feature'
    })
  })

  it('reports a transport failure instead of throwing it', async () => {
    const { runGit } = makeRunner({
      config: CONFIGURED_UPSTREAM,
      refs: ['refs/remotes/origin/feature'],
      pushError: new Error('fatal: could not read Username for https://github.com')
    })
    const target = await resolveRemoteBranchTarget(runGit, 'feature')

    // The checkout is already deleted by this point, so a failure has to be an outcome, not a throw.
    await expect(
      deleteRemoteBranchAfterLocalBranchRemoval({ runGit, branchName: 'feature', target })
    ).resolves.toEqual({
      status: 'failed',
      remoteName: 'origin',
      branchName: 'feature',
      message: 'fatal: could not read Username for https://github.com'
    })
  })
})
