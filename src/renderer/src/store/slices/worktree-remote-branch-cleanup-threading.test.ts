import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteBranchCleanup } from '../../../../shared/worktree/remote-branch-removal'
import type { AppState } from '../types'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
} from './worktrees-slice-test-harness'

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

beforeEach(resetWorktreeSliceModuleMemory)

const WORKTREE_ID = 'repo1::/path/wt1'
const DELETED: RemoteBranchCleanup = {
  status: 'deleted',
  remoteName: 'origin',
  branchName: 'feature'
}

function seed(store: ReturnType<typeof createTestStore>, runtimeEnvironmentId?: string): void {
  const worktree = makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })
  // The slice reads only `activeRuntimeEnvironmentId` to choose a transport, so a full
  // GlobalSettings object would be noise here.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: narrow settings stub for transport routing; no other setting is read on this path.
  const settings = {
    activeRuntimeEnvironmentId: runtimeEnvironmentId ?? null
  } as AppState['settings']
  store.setState({ worktreesByRepo: { repo1: [worktree] }, settings })
}

function removeWithRemoteBranch(store: ReturnType<typeof createTestStore>) {
  return store.getState().removeWorktree({ id: WORKTREE_ID, executionHostId: null }, false, {
    deleteRemoteBranch: true
  })
}

describe('remote branch cleanup threading', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  // Regression: `removeWorktree` rebuilds its success result as a literal, so a field it forgets to
  // name typechecks (it is optional) and then silently never reaches the opt-in notice.
  it('carries the local removal cleanup through to the caller', async () => {
    const store = createTestStore()
    seed(store)
    vi.mocked(mockApi.worktrees.remove).mockResolvedValue({ remoteBranchCleanup: DELETED })

    const result = await removeWithRemoteBranch(store)

    expect(mockApi.worktrees.remove).toHaveBeenCalledWith(
      expect.objectContaining({ deleteRemoteBranch: true })
    )
    expect(result).toEqual({ ok: true, remoteBranchCleanup: DELETED })
  })

  it('keeps a preserved local branch alongside the remote cleanup', async () => {
    const store = createTestStore()
    seed(store)
    vi.mocked(mockApi.worktrees.remove).mockResolvedValue({
      preservedBranch: { branchName: 'feature', head: 'abc123' },
      remoteBranchCleanup: { status: 'skipped-preserved' }
    })

    const result = await removeWithRemoteBranch(store)

    expect(result).toEqual({
      ok: true,
      preservedBranch: expect.objectContaining({ branchName: 'feature', head: 'abc123' }),
      remoteBranchCleanup: { status: 'skipped-preserved' }
    })
  })

  it('does not ask the host for anything when the option is off', async () => {
    const store = createTestStore()
    seed(store)
    vi.mocked(mockApi.worktrees.remove).mockResolvedValue({})

    const result = await store
      .getState()
      .removeWorktree({ id: WORKTREE_ID, executionHostId: null }, false)

    expect(mockApi.worktrees.remove).toHaveBeenCalledWith(
      expect.not.objectContaining({ deleteRemoteBranch: true })
    )
    expect(result).toEqual({ ok: true })
  })

  // A runtime host that never heard of the param drops it and answers without a cleanup, so silence
  // would leave the user believing the remote branch is gone.
  it('reports a runtime host that answered without a cleanup', async () => {
    const store = createTestStore()
    seed(store, 'env-1')
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-rm',
      ok: true,
      result: { removed: true },
      _meta: { runtimeId: 'runtime-remote' }
    })

    const result = await removeWithRemoteBranch(store)

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        remoteBranchCleanup: { status: 'failed' }
      })
    )
  })

  it('passes a runtime host cleanup through unchanged', async () => {
    const store = createTestStore()
    seed(store, 'env-1')
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-rm',
      ok: true,
      result: { removed: true, remoteBranchCleanup: DELETED },
      _meta: { runtimeId: 'runtime-remote' }
    })

    const result = await removeWithRemoteBranch(store)

    expect(result).toEqual(expect.objectContaining({ remoteBranchCleanup: DELETED }))
  })
})
