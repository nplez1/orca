// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import type { ReadyProjectHostSetupOption } from '@/lib/project-host-setup-options'

const storeMocks = vi.hoisted(() => {
  const worktreesByRepo: Record<string, Worktree[]> = {}
  return { fetchWorktrees: vi.fn(), worktreesByRepo }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector(storeMocks),
    { getState: () => storeMocks }
  )
}))

import { useWorkspaceCopyTarget } from './use-workspace-copy-target'

const CLONE_PATH = '/Users/alice/code/orca'

function readyOption(
  overrides: Partial<ReadyProjectHostSetupOption> = {}
): ReadyProjectHostSetupOption {
  return {
    id: 'setup-b',
    kind: 'ready',
    projectId: 'github:acme/app',
    hostId: 'runtime:env-b',
    repoId: 'repo-b',
    label: 'Build box',
    detail: 'orca',
    path: CLONE_PATH,
    ...overrides
  }
}

function worktreeAt(path: string, branch: string): Worktree {
  return {
    id: `repo-b::${path}`,
    repoId: 'repo-b',
    path,
    head: 'abc1234',
    branch,
    isBare: false,
    isMainWorktree: true,
    displayName: 'main',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

function renderCopyTarget(
  overrides: Partial<Parameters<typeof useWorkspaceCopyTarget>[0]> = {},
  worktrees: Worktree[] = []
) {
  storeMocks.fetchWorktrees.mockReset()
  storeMocks.worktreesByRepo = { 'repo-b': worktrees }
  return renderHook(() =>
    useWorkspaceCopyTarget({
      lockedWorkspaceBranch: 'main',
      sourceHostId: 'local',
      projectHostSetupOptions: [readyOption()],
      selectedProjectHostSetupId: 'setup-b',
      selectedRepoExecutionHostId: 'runtime:env-b',
      ...overrides
    })
  )
}

afterEach(() => {
  cleanup()
})

describe('useWorkspaceCopyTarget', () => {
  it('treats our own clone that already holds the branch as the copy', async () => {
    const { result } = renderCopyTarget({}, [worktreeAt(CLONE_PATH, 'refs/heads/main')])

    act(() => result.current.recordProvisionedSetup('["setup-b","runtime:env-b"]', 'cloned'))
    await expect(result.current.resolveCloneLandedCopy()).resolves.toMatchObject({
      id: `repo-b::${CLONE_PATH}`
    })
    expect(storeMocks.fetchWorktrees).toHaveBeenCalledWith('repo-b')
  })

  it('never calls a checkout we did not clone the copy, even on the same branch', async () => {
    const { result } = renderCopyTarget({}, [worktreeAt(CLONE_PATH, 'refs/heads/main')])

    // Why: an import of an existing folder is a pre-existing checkout, which stays a refusal.
    act(() => result.current.recordProvisionedSetup('["setup-b","runtime:env-b"]', 'existing-folder'))

    await expect(result.current.resolveCloneLandedCopy()).resolves.toBeNull()
    expect(storeMocks.fetchWorktrees).not.toHaveBeenCalled()
  })

  it('leaves the create alone when the clone checked out another branch', async () => {
    const { result } = renderCopyTarget({}, [worktreeAt(CLONE_PATH, 'refs/heads/develop')])

    act(() => result.current.recordProvisionedSetup('["setup-b","runtime:env-b"]', 'cloned'))

    await expect(result.current.resolveCloneLandedCopy()).resolves.toBeNull()
  })

  it('is inert outside a copy, and refuses the source host and a lone host', () => {
    const plain = renderCopyTarget({
      lockedWorkspaceBranch: undefined,
      projectHostSetupOptions: [readyOption({ hostId: 'local', id: 'setup-local' })],
      selectedRepoExecutionHostId: 'local',
      selectedProjectHostSetupId: 'setup-local'
    })
    expect(plain.result.current.lockedTargetIsSourceHost).toBe(false)
    expect(plain.result.current.onlySourceHostAvailable).toBe(false)

    const onSource = renderCopyTarget({
      projectHostSetupOptions: [readyOption({ hostId: 'local', id: 'setup-local' })],
      selectedRepoExecutionHostId: 'local',
      selectedProjectHostSetupId: 'setup-local'
    })
    expect(onSource.result.current.lockedTargetIsSourceHost).toBe(true)
    expect(onSource.result.current.onlySourceHostAvailable).toBe(true)
  })

  it('names the selected target host so the outcome can report it', () => {
    const { result } = renderCopyTarget()

    expect(result.current.selectedTargetHostLabel).toBe('Build box')
  })
})
