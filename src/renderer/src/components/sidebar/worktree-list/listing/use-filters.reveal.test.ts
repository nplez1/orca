import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'

type TestStoreState = Record<string, unknown>

const store = vi.hoisted((): { state: TestStoreState } => ({ state: {} }))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => store.state }
}))

const { revealWorkspaceRowFilters } = await import('./use-filters')

const setFilterRepoIds = vi.fn()
const setHiddenWorkspaceStatusIds = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  store.state = {
    showSleepingWorkspaces: true,
    filterRepoIds: ['repo-a'],
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    hideCliCreatedWorkspaces: false,
    hideDetachedHeadWorkspaces: false,
    hideWorkspacesFromOtherDevices: false,
    alwaysShowDefaultBranchWorkspace: true,
    visibleWorkspaceHostIds: null,
    workspaceHostScope: 'all',
    hiddenWorkspaceStatusIds: ['done'],
    repos: [{ id: 'repo-a' }, { id: 'repo-b' }],
    projectGroups: [],
    settings: {},
    runtimeEnvironments: [],
    runtimeStatusByEnvironmentId: new Map(),
    setFilterRepoIds,
    setHiddenWorkspaceStatusIds
  }
})

describe('revealWorkspaceRowFilters', () => {
  it('turns off only the shared filter hiding the workspace', () => {
    revealWorkspaceRowFilters(makeWorktree({ id: 'wt', repoId: 'repo-b', workspaceStatus: 'done' }))

    expect(setFilterRepoIds).toHaveBeenCalledWith(['repo-a', 'repo-b'])
  })

  it('leaves the sidebar status filter alone, which the board never applies', () => {
    revealWorkspaceRowFilters(makeWorktree({ id: 'wt', repoId: 'repo-b', workspaceStatus: 'done' }))

    expect(setHiddenWorkspaceStatusIds).not.toHaveBeenCalled()
  })
})
