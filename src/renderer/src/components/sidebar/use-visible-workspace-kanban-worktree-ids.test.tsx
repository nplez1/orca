// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { makeRepo, makeWorktree } from '../worktree-jump-palette-test-fixtures'
import { useVisibleWorkspaceKanbanWorktreeIds } from './use-visible-workspace-kanban-worktree-ids'

const initialState = useAppStore.getInitialState()

describe('useVisibleWorkspaceKanbanWorktreeIds', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
  })

  it('keeps a single-host filter host-qualified when workspace ids collide', () => {
    const local = makeWorktree('shared', 'Local workspace', { hostId: 'local' })
    const ssh = makeWorktree('shared', 'SSH workspace', { hostId: 'ssh:box' })
    const repo = makeRepo()
    useAppStore.setState({
      worktreesByRepo: { [repo.id]: [local, ssh] },
      showSleepingWorkspaces: true,
      visibleWorkspaceHostIds: ['local']
    })

    const { result } = renderHook(() =>
      useVisibleWorkspaceKanbanWorktreeIds({
        allWorktrees: [local, ssh],
        repoMap: new Map([[repo.id, repo]])
      })
    )

    expect(result.current).toEqual(new Set([getWorktreeHostIdentity(local)]))
  })

  it('keeps status-hidden workspaces on the board so they can be dragged to a shown lane', () => {
    const hidden = { ...makeWorktree('hidden', 'Hidden status'), workspaceStatus: 'completed' }
    const shown = { ...makeWorktree('shown', 'Shown status'), workspaceStatus: 'todo' }
    const repo = makeRepo()
    useAppStore.setState({
      worktreesByRepo: { [repo.id]: [hidden, shown] },
      showSleepingWorkspaces: true,
      hiddenWorkspaceStatusIds: ['completed']
    })

    const { result } = renderHook(() =>
      useVisibleWorkspaceKanbanWorktreeIds({
        allWorktrees: [hidden, shown],
        repoMap: new Map([[repo.id, repo]])
      })
    )

    expect(result.current).toEqual(
      new Set([getWorktreeHostIdentity(hidden), getWorktreeHostIdentity(shown)])
    )
  })

  it('still applies non-status filters to the board', () => {
    const onBranch = makeWorktree('on-branch', 'On branch')
    const detached = makeWorktree('detached', 'Detached', { branch: '', head: 'deadbeefcafe' })
    const repo = makeRepo()
    useAppStore.setState({
      worktreesByRepo: { [repo.id]: [onBranch, detached] },
      showSleepingWorkspaces: true,
      hideDetachedHeadWorkspaces: true
    })

    const { result } = renderHook(() =>
      useVisibleWorkspaceKanbanWorktreeIds({
        allWorktrees: [onBranch, detached],
        repoMap: new Map([[repo.id, repo]])
      })
    )

    expect(result.current).toEqual(new Set([getWorktreeHostIdentity(onBranch)]))
  })
})
