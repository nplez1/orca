import { describe, expect, it, vi } from 'vitest'
import { WORKTREE_ID_SEPARATOR } from '../../../shared/terminal/pty/lifecycle/pty-session-id-format'

vi.mock('../../github/app/github-app-credentials', () => ({
  readGithubAppCredentials: async () => null
}))

const { getLocalRemoteSyncGitOptions, getLocalRepoForRegisteredWorktree } =
  await import('./local-worktree-runtime-options')

type TestRepo = {
  id: string
  path: string
  connectionId?: string
  ghAccount?: { host: string; user: string; kind?: 'user' | 'app' }
}

const makeStore = (
  repos: readonly TestRepo[],
  worktreeIds: readonly string[]
): { store: never } => {
  const meta = Object.fromEntries(worktreeIds.map((id) => [id, {}]))
  const store = {
    getRepos: () => repos,
    getAllWorktreeMeta: () => meta
  }
  // SAFETY: This fixture supplies the catalog methods used by the repo lookup.
  return { store: store as never }
}

const worktreeId = (repoId: string, path: string): string =>
  `${repoId}${WORKTREE_ID_SEPARATOR}${path}`

describe('getLocalRemoteSyncGitOptions', () => {
  it('refuses a project bound to the GitHub App when no App is connected', async () => {
    const { store } = makeStore(
      [
        {
          id: 'bound',
          path: '/repos/bound',
          ghAccount: { host: 'github.com', user: 'lab-agent-np[bot]', kind: 'app' }
        }
      ],
      []
    )
    const error = await getLocalRemoteSyncGitOptions(store, '/repos/bound', '/repos/bound').catch(
      (caught: unknown) => caught
    )
    expect(error).toMatchObject({
      code: 'gh_bound_account_unavailable',
      message: expect.stringContaining('no App is connected')
    })
  })

  it('leaves a project bound to a person on the ambient login', async () => {
    const { store } = makeStore(
      [{ id: 'mine', path: '/repos/mine', ghAccount: { host: 'github.com', user: 'nplez1' } }],
      []
    )
    await expect(
      getLocalRemoteSyncGitOptions(store, '/repos/mine', '/repos/mine')
    ).resolves.toEqual({})
  })
})

describe('getLocalRepoForRegisteredWorktree', () => {
  describe('equivalence with the per-repo scan', () => {
    const repos: TestRepo[] = [
      { id: 'first', path: '/repos/first' },
      { id: 'middle', path: '/repos/middle' },
      { id: 'last', path: '/repos/last' }
    ]

    it('keeps getRepos precedence when two repos both own the path', () => {
      const { store } = makeStore(repos, [
        worktreeId('last', '/wt/shared'),
        worktreeId('middle', '/wt/shared')
      ])
      // getRepos order decides, not the meta table's insertion order.
      expect(getLocalRepoForRegisteredWorktree(store, '/wt/shared', '/wt/shared')?.id).toBe(
        'middle'
      )
    })

    it('excludes an SSH repo even when it owns the registered worktree', () => {
      const { store } = makeStore(
        [{ id: 'remote', path: '/repos/remote', connectionId: 'm4air' }, ...repos],
        [worktreeId('remote', '/wt/one'), worktreeId('middle', '/wt/one')]
      )
      expect(getLocalRepoForRegisteredWorktree(store, '/wt/one', '/wt/one')?.id).toBe('middle')

      const onlyRemote = makeStore(
        [{ id: 'remote', path: '/repos/remote', connectionId: 'm4air' }],
        [worktreeId('remote', '/wt/one')]
      )
      expect(
        getLocalRepoForRegisteredWorktree(onlyRemote.store, '/wt/one', '/wt/one')
      ).toBeUndefined()
    })
  })
})
