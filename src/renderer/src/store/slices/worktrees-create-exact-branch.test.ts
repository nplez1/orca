import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TEST_REPO, makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
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

vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice: vi.fn()
}))

beforeEach(resetWorktreeSliceModuleMemory)

describe('createWorktree with an implied branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  function createStore() {
    const store = createTestStore()
    store.setState({ repos: [{ ...TEST_REPO, executionHostId: 'local' }] })
    return store
  }

  function create(store: ReturnType<typeof createTestStore>, options: Record<string, unknown>) {
    const createWorktree = store.getState().createWorktree
    const args: Parameters<typeof createWorktree> = [
      TEST_REPO.id,
      'fix-login',
      'origin/fix-login',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'fix-login'
    ]
    args[25] = options
    return createWorktree(...args)
  }

  it('surfaces the host refusal instead of retrying into a suffixed branch', async () => {
    const store = createStore()
    mockApi.worktrees.create.mockRejectedValue(
      new Error(
        'Branch "fix-login" already exists locally, and this workspace keeps its branch name.'
      )
    )

    await expect(create(store, { exactBranchName: true })).rejects.toThrow(/keeps its branch name/)

    // Why: the copy must keep its branch, so a retry with `fix-login-2` is the failure mode.
    expect(mockApi.worktrees.create).toHaveBeenCalledTimes(1)
    expect(mockApi.worktrees.create.mock.calls[0][0]).toMatchObject({ exactBranchName: true })
  })

  it('still retries a branch conflict when the branch is not implied', async () => {
    const store = createStore()
    mockApi.worktrees.create
      .mockRejectedValueOnce(new Error('Branch "fix-login" already exists locally.'))
      .mockResolvedValue({
        worktree: makeWorktree({ id: 'repo1::/path/fix-login-2', repoId: TEST_REPO.id })
      })

    await create(store, {})

    expect(mockApi.worktrees.create).toHaveBeenCalledTimes(2)
    expect(mockApi.worktrees.create.mock.calls[1][0]).toMatchObject({
      branchNameOverride: 'fix-login-2'
    })
  })
})
