import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeWorktree } from '../../worktrees-slice-test-fixtures'
import { makeDetectedResult } from '../../worktrees-detected-listing-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
} from '../../worktrees-slice-test-harness'

const WORKTREE_ID = 'repo1::/path/wt1'

beforeEach(() => {
  resetWorktreeSliceModuleMemory()
  resetRemoteRuntimeMocks()
  vi.clearAllMocks()
  // Why reset: `clearAllMocks` keeps implementations, so a rejection installed by one case would
  // silently decide the next one.
  mockApi.worktrees.updateMeta.mockReset()
  mockApi.worktrees.updateMeta.mockResolvedValue(undefined)
})

/** One id, three host stamps: this is the shape STA-4343 publishes for a shared workspace. */
function seedHostTwins(store: ReturnType<typeof createTestStore>): void {
  store.setState({
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', hostId: 'local' }),
        makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', hostId: 'ssh:box' }),
        makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', hostId: 'runtime:env-1' })
      ]
    },
    sshTargetLabels: new Map([['box', 'Mac Studio']])
  })
}

function acceptRemoteRename(): void {
  runtimeEnvironmentCall.mockResolvedValue({
    id: 'rpc-rename',
    ok: true,
    result: { worktree: makeWorktree({ id: WORKTREE_ID, repoId: 'repo1' }) },
    _meta: { runtimeId: 'runtime-remote' }
  })
}

function rows(store: ReturnType<typeof createTestStore>) {
  return store.getState().worktreesByRepo.repo1
}

function localWrites(): { executionHostId?: string; displayName?: string }[] {
  return mockApi.worktrees.updateMeta.mock.calls.map(([args]) => ({
    executionHostId: args.executionHostId,
    displayName: args.updates.displayName
  }))
}

function rename(
  store: ReturnType<typeof createTestStore>,
  updates: { displayName?: string; comment?: string } = { displayName: 'Renamed everywhere' }
) {
  return store.getState().updateWorktreeMeta(WORKTREE_ID, updates, { executionHostId: 'local' })
}

describe('renaming a workspace that is on several hosts', () => {
  it('renames on every host that publishes it, in one action', async () => {
    const store = createTestStore()
    seedHostTwins(store)
    acceptRemoteRename()

    const result = await rename(store)

    expect(result).toEqual({ ok: true })
    expect(localWrites()).toEqual([
      { executionHostId: 'local', displayName: 'Renamed everywhere' },
      { executionHostId: 'ssh:box', displayName: 'Renamed everywhere' }
    ])
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'worktree.set',
        params: expect.objectContaining({ displayName: 'Renamed everywhere' })
      })
    )
  })

  it('shows the new name on every host row before any write answers', async () => {
    const store = createTestStore()
    seedHostTwins(store)
    acceptRemoteRename()

    const pending = rename(store)

    expect(rows(store).map((row) => row.displayName)).toEqual([
      'Renamed everywhere',
      'Renamed everywhere',
      'Renamed everywhere'
    ])
    await pending
  })

  it('keeps the hosts that took the name and reverts only the one that refused', async () => {
    const store = createTestStore()
    seedHostTwins(store)
    acceptRemoteRename()
    mockApi.worktrees.updateMeta.mockImplementation((args) =>
      args.executionHostId === 'ssh:box'
        ? Promise.reject(new Error('ssh target refused'))
        : Promise.resolve(undefined)
    )

    const result = await rename(store)

    expect(result.ok).toBe(false)
    // Why the label: the report names the host the way the sidebar shows it.
    expect(result.ok === false && result.error).toContain('Mac Studio')
    expect(result.ok === false && result.error).not.toContain('env-1')
    // Why the mode: the refusal restores the row's own name *and* how it was named.
    expect(rows(store).map((row) => [row.displayName, row.displayNameMode])).toEqual([
      ['Renamed everywhere', 'fixed'],
      ['feature', 'automatic'],
      ['Renamed everywhere', 'fixed']
    ])
  })

  it('names the twin rows with the name only, never the rest of a mixed update', async () => {
    const store = createTestStore()
    seedHostTwins(store)
    acceptRemoteRename()

    await rename(store, { displayName: 'Renamed everywhere', comment: 'note for one host' })

    const [local, ssh, remote] = rows(store)
    expect([local?.displayName, local?.comment]).toEqual([
      'Renamed everywhere',
      'note for one host'
    ])
    // Why: the twins never receive the comment, so their rows must not claim it optimistically.
    expect([ssh?.displayName, ssh?.comment]).toEqual(['Renamed everywhere', ''])
    expect([remote?.displayName, remote?.comment]).toEqual(['Renamed everywhere', ''])
  })

  it('still renames the other hosts when the host being edited refuses', async () => {
    const store = createTestStore()
    seedHostTwins(store)
    acceptRemoteRename()
    mockApi.worktrees.updateMeta.mockImplementation((args) =>
      args.executionHostId === 'local'
        ? Promise.reject(new Error('local refused'))
        : Promise.resolve(undefined)
    )

    const result = await rename(store)

    expect(result.ok).toBe(false)
    expect(localWrites().map((write) => write.executionHostId)).toEqual(['local', 'ssh:box'])
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
  })

  it('writes a paired HUB row once for the one server that owns it', async () => {
    const store = createTestStore()
    acceptRemoteRename()
    store.setState({
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: WORKTREE_ID,
            repoId: 'repo1',
            hostId: 'ssh:hub-target',
            runtimeOwnerEnvironmentId: 'env-1'
          })
        ]
      }
    })

    const result = await rename(store)

    expect(result).toEqual({ ok: true })
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  it('renames a host that publishes the workspace only as a detected row', async () => {
    const store = createTestStore()
    acceptRemoteRename()
    store.setState({
      worktreesByRepo: {
        repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', hostId: 'local' })]
      },
      detectedWorktreesByRepo: {
        repo1: makeDetectedResult('repo1', [
          makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', hostId: 'ssh:box' })
        ])
      }
    })

    const result = await rename(store)

    expect(result).toEqual({ ok: true })
    expect(localWrites().map((write) => write.executionHostId)).toEqual(['local', 'ssh:box'])
  })

  it('shows the name on a row whose host id lost the store dedupe', async () => {
    const store = createTestStore()
    acceptRemoteRename()
    store.setState({
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', hostId: 'local' }),
          makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', hostId: 'runtime:env-1' }),
          // Why: this row's route resolves to the same store as the row above, so only one write is
          // owed — but both rows publish the workspace and both must show the new name.
          makeWorktree({
            id: WORKTREE_ID,
            repoId: 'repo1',
            hostId: 'ssh:hub-target',
            runtimeOwnerEnvironmentId: 'env-1'
          })
        ]
      }
    })

    const result = await rename(store)

    expect(result).toEqual({ ok: true })
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
    expect(rows(store).map((row) => row.displayName)).toEqual([
      'Renamed everywhere',
      'Renamed everywhere',
      'Renamed everywhere'
    ])
  })

  it('reports a host it cannot reach instead of showing a name nothing wrote', async () => {
    const store = createTestStore()
    store.setState({
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', hostId: 'local' }),
          makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', hostId: 'runtime:unresolved-owner' })
        ]
      }
    })

    const result = await rename(store)

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('unresolved-owner')
    expect(rows(store).map((row) => row.displayName)).toEqual(['Renamed everywhere', 'feature'])
  })

  it('leaves a non-rename update scoped to the host it was made on', async () => {
    const store = createTestStore()
    seedHostTwins(store)

    await rename(store, { comment: 'note for one host' })

    expect(localWrites()).toEqual([{ executionHostId: 'local', displayName: undefined }])
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })
})
