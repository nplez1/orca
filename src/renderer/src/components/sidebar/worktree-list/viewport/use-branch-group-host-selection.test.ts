// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import type { BranchGroupMember, WorktreeRow } from '../grouping/row-types'
import {
  remoteRepo,
  remoteWorktree,
  repo,
  worktree
} from '../../worktree-list-groups-test-fixtures'
import {
  findBranchGroupHostTarget,
  useBranchGroupHostSelection
} from './use-branch-group-host-selection'

const { activateWorktreeFromSidebar } = vi.hoisted(() => ({
  activateWorktreeFromSidebar: vi.fn()
}))

vi.mock('@/lib/sidebar-worktree-activation', () => ({
  activateWorktreeFromSidebar
}))

const GROUP_KEY = 'project:p1\u0000feature/super-critical'

const members: BranchGroupMember[] = [
  { hostId: LOCAL_EXECUTION_HOST_ID, hostLabel: 'Local Mac', repo, worktree },
  {
    hostId: 'ssh:gpu-vm',
    hostLabel: 'GPU VM',
    repo: remoteRepo,
    worktree: remoteWorktree
  }
]

function makeRow(): WorktreeRow {
  return {
    type: 'item',
    rowKey: 'row-1',
    sectionKey: 'project:p1',
    // Why: a merged row always holds its local-first member, never the shown host.
    worktree,
    repo,
    depth: 0,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: false,
    lineageChildCount: 0,
    branchGroupKey: GROUP_KEY,
    branchGroup: members
  }
}

afterEach(() => {
  cleanup()
  activateWorktreeFromSidebar.mockClear()
})

describe('findBranchGroupHostTarget', () => {
  it('finds a non-primary member by group key and host', () => {
    const target = findBranchGroupHostTarget([makeRow()], GROUP_KEY, 'ssh:gpu-vm')

    expect(target?.member.worktree.id).toBe(remoteWorktree.id)
    expect(target?.rowKey).toBe('row-1')
  })

  it('ignores rows for another group or a missing host', () => {
    expect(findBranchGroupHostTarget([makeRow()], 'other-group', 'ssh:gpu-vm')).toBeNull()
    expect(findBranchGroupHostTarget([makeRow()], GROUP_KEY, 'ssh:missing')).toBeNull()
  })
})

describe('useBranchGroupHostSelection', () => {
  it('activates the chosen host workspace, not the row primary', () => {
    const setBranchGroupHost = vi.fn()
    const onImmediateActivate = vi.fn()
    const { result } = renderHook(() =>
      useBranchGroupHostSelection({
        rows: [makeRow()],
        setBranchGroupHost,
        onImmediateActivate
      })
    )

    act(() => {
      result.current(GROUP_KEY, 'ssh:gpu-vm')
    })

    expect(setBranchGroupHost).toHaveBeenCalledWith(GROUP_KEY, 'ssh:gpu-vm')
    expect(onImmediateActivate).toHaveBeenCalledWith(remoteWorktree.id, 'row-1')
    expect(activateWorktreeFromSidebar).toHaveBeenCalledWith(remoteWorktree.id, 'ssh:gpu-vm')
  })

  it('only records the host choice when the row is gone', () => {
    const setBranchGroupHost = vi.fn()
    const { result } = renderHook(() =>
      useBranchGroupHostSelection({
        rows: [],
        setBranchGroupHost,
        onImmediateActivate: vi.fn()
      })
    )

    act(() => {
      result.current(GROUP_KEY, 'ssh:gpu-vm')
    })

    expect(setBranchGroupHost).toHaveBeenCalledWith(GROUP_KEY, 'ssh:gpu-vm')
    expect(activateWorktreeFromSidebar).not.toHaveBeenCalled()
  })
})
