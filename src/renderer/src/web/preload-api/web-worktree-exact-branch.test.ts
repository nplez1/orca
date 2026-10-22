import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WORKTREE_EXACT_BRANCH_NAME_RUNTIME_CAPABILITY } from '../../../../shared/worktree-runtime-capabilities'
import { createWorktreesApi } from './web-worktrees-api'

const mocks = vi.hoisted(() => ({ status: vi.fn(), call: vi.fn(), assertEnvironment: vi.fn() }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./web-runtime-calls', () => ({
  getRemoteRuntimeStatus: mocks.status,
  callRuntimeResultWithOwner: mocks.call,
  callRuntimeResult: vi.fn(),
  withRuntimeWorktreeOwner: (row: unknown) => row
}))
vi.mock('./web-runtime-session', () => ({
  invalidateRuntimeWorktreeCaches: vi.fn(),
  requireActiveEnvironment: () => ({ id: 'env' }),
  assertActiveEnvironment: mocks.assertEnvironment
}))
vi.mock('./web-runtime-worktree-catalog', () => ({
  WEB_RUNTIME_WORKTREE_LIST_LIMIT: 500,
  callRuntimeDetectedWorktrees: vi.fn(),
  listAllRuntimeWorktrees: vi.fn()
}))

const exactCreate = {
  repoId: 'repo-1',
  name: 'fix-login',
  baseBranch: 'origin/fix-login',
  branchNameOverride: 'fix-login',
  exactBranchName: true
} as const

beforeEach(() => {
  vi.clearAllMocks()
  mocks.call.mockResolvedValue({ result: { worktree: { id: 'wt' } }, hostId: 'runtime:env' })
})

describe('paired web exact-branch create', () => {
  it('refuses a host that would drop the flag and suffix the branch', async () => {
    mocks.status.mockResolvedValue({ capabilities: [] })

    await expect(createWorktreesApi().create(exactCreate)).rejects.toThrow(
      'Update the remote runtime to copy a workspace to it'
    )
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('forwards the flag once the host advertises support', async () => {
    mocks.status.mockResolvedValue({
      capabilities: [WORKTREE_EXACT_BRANCH_NAME_RUNTIME_CAPABILITY]
    })

    await createWorktreesApi().create(exactCreate)

    expect(mocks.call).toHaveBeenCalledWith(
      'worktree.create',
      expect.objectContaining({ exactBranchName: true, branchNameOverride: 'fix-login' })
    )
    expect(mocks.assertEnvironment).toHaveBeenCalledWith('env')
  })
})
