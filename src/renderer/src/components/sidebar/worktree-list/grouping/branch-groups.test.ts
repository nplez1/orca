import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host/execution-host'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { resolveBranchGroupSelection } from './branch-groups'
import { mergeSameBranchRows } from './same-branch-row-merge'
import { buildProjectGroupingIndex } from '../../../../../../shared/sidebar-list/sections/project-section-grouping'
import {
  PINNED_GROUP_KEY,
  getWorktreeLineageGroupKey
} from '../../../../../../shared/sidebar-list/sections/group-keys'
import type {
  BranchGroupMember,
  Row,
  WorktreeRow
} from '../../../../../../shared/sidebar-list/row-types'
import {
  project,
  projectHostSetups,
  remoteRepo,
  remoteWorktree,
  repo,
  worktree
} from './worktree-list-groups-test-fixtures'

const projectRepoMap: ReadonlyMap<string, Repo> = new Map([
  [repo.id, repo],
  [remoteRepo.id, remoteRepo]
])

const projectIndex = buildProjectGroupingIndex({
  projects: [project],
  projectHostSetups
})

function itemRow(overrides: Partial<WorktreeRow> & { worktree: Worktree }): WorktreeRow {
  return {
    type: 'item',
    rowKey: `project:p1:${overrides.worktree.id}`,
    sectionKey: 'project:p1',
    repo: projectRepoMap.get(overrides.worktree.repoId),
    depth: 0,
    groupDepth: 0,
    isLastLineageChild: false,
    lineageChildCount: 0,
    ...overrides
  }
}

const hostLabels = new Map([
  [LOCAL_EXECUTION_HOST_ID, 'Local Mac'],
  ['ssh:gpu-vm', 'GPU VM']
])

function merge(rows: readonly Row[], collapsedGroups?: ReadonlySet<string>): Row[] {
  return mergeSameBranchRows(
    rows,
    projectRepoMap,
    projectIndex,
    LOCAL_EXECUTION_HOST_ID,
    hostLabels,
    collapsedGroups
  )
}

const LOCAL_PARENT_GROUP = getWorktreeLineageGroupKey(worktree)
const REMOTE_PARENT_GROUP = getWorktreeLineageGroupKey(remoteWorktree)

function childRow(parent: Worktree, childId: string): WorktreeRow {
  return itemRow({
    worktree: { ...parent, id: childId },
    rowKey: `project:p1:${childId}`,
    depth: 1
  })
}

function parentRow(
  parent: Worktree,
  childIds: readonly string[],
  overrides: Partial<WorktreeRow> = {}
): WorktreeRow {
  return itemRow({
    worktree: parent,
    rowKey: `project:p1:${parent.id}`,
    lineageChildCount: childIds.length,
    lineageChildWorktreeIds: childIds,
    ...(childIds.length > 0
      ? { lineageGroupKey: getWorktreeLineageGroupKey(parent), lineageCollapsed: false }
      : {}),
    ...overrides
  })
}

describe('mergeSameBranchRows with lineage children', () => {
  // The M5/Win report: one host's main workspace gained a child and the pair split
  // into two rows, losing the host selector.
  const localChild = childRow(worktree, 'wt-1-child')
  const remoteChildA = childRow(remoteWorktree, 'wt-remote-child-a')
  const remoteChildB = childRow(remoteWorktree, 'wt-remote-child-b')
  const localParent = parentRow(worktree, ['wt-1-child'])
  const remoteParent = parentRow(remoteWorktree, ['wt-remote-child-a', 'wt-remote-child-b'])

  it('stacks the hosts even when one side has children', () => {
    const result = merge([localParent, localChild, remoteParent, remoteChildA, remoteChildB])

    expect(result).toHaveLength(4)
    const merged = result[0]
    expect(merged.type).toBe('item')
    if (merged.type !== 'item') {
      return
    }
    expect(merged.worktree.id).toBe(worktree.id)
    expect(merged.branchGroup?.map((member) => member.hostId)).toEqual([
      LOCAL_EXECUTION_HOST_ID,
      'ssh:gpu-vm'
    ])
    expect(result.slice(1).map((row) => (row.type === 'item' ? row.rowKey : row.type))).toEqual([
      localChild.rowKey,
      remoteChildA.rowKey,
      remoteChildB.rowKey
    ])
  })

  it('carries the union of every member child under the merged card', () => {
    const result = merge([localParent, localChild, remoteParent, remoteChildA, remoteChildB])
    const merged = result[0]
    if (merged.type !== 'item') {
      throw new Error('expected the merged card')
    }

    expect(merged.lineageChildCount).toBe(3)
    expect(merged.lineageChildWorktreeIds).toEqual([
      'wt-1-child',
      'wt-remote-child-a',
      'wt-remote-child-b'
    ])
    expect(merged.lineageCollapseKeys).toEqual([LOCAL_PARENT_GROUP, REMOTE_PARENT_GROUP])
    expect(merged.lineageGroupKey).toBe(LOCAL_PARENT_GROUP)
    expect(merged.lineageCollapsed).toBe(false)
    expect(merged.hostContextLabel).toBeUndefined()
  })

  it('moves the other host children up under the merged card', () => {
    // The remote row sorts first here, so its subtree must travel to the card.
    const result = merge([remoteParent, remoteChildA, remoteChildB, localParent, localChild])

    expect(result.map((row) => (row.type === 'item' ? row.rowKey : row.type))).toEqual([
      localParent.rowKey,
      localChild.rowKey,
      remoteChildA.rowKey,
      remoteChildB.rowKey
    ])
  })

  it('keeps the union count when the only children sit on the non-primary host', () => {
    const childlessLocal = parentRow(worktree, [])
    const result = merge([childlessLocal, remoteParent, remoteChildA, remoteChildB])
    const merged = result[0]
    if (merged.type !== 'item') {
      throw new Error('expected the merged card')
    }

    expect(result).toHaveLength(3)
    expect(merged.lineageChildCount).toBe(2)
    // The childless primary owns no group of its own, so the card borrows the one that has children.
    expect(merged.lineageGroupKey).toBe(REMOTE_PARENT_GROUP)
    expect(merged.lineageCollapseKeys).toEqual([REMOTE_PARENT_GROUP])
  })

  it('folds every member child when the card is collapsed', () => {
    const rows = [localParent, localChild, remoteParent, remoteChildA, remoteChildB]
    const result = merge(rows, new Set([LOCAL_PARENT_GROUP]))

    expect(result).toHaveLength(1)
    const merged = result[0]
    expect(merged.type === 'item' && merged.lineageCollapsed).toBe(true)
    expect(merged.type === 'item' && merged.lineageChildCount).toBe(3)
  })

  it('treats any collapsed member as the whole card folded', () => {
    const rows = [localParent, localChild, remoteParent, remoteChildA, remoteChildB]

    expect(merge(rows, new Set([REMOTE_PARENT_GROUP]))).toHaveLength(1)
  })
})

describe('mergeSameBranchRows', () => {
  it('collapses the same branch on two hosts into one row, local first', () => {
    const local = itemRow({ worktree })
    const remote = itemRow({ worktree: remoteWorktree })

    const result = merge([remote, local])

    expect(result).toHaveLength(1)
    const merged = result[0]
    expect(merged.type).toBe('item')
    if (merged.type !== 'item') {
      return
    }
    expect(merged.worktree.id).toBe(worktree.id)
    expect(merged.hostContextLabel).toBeUndefined()
    expect(merged.branchGroup?.map((member) => member.hostId)).toEqual([
      LOCAL_EXECUTION_HOST_ID,
      'ssh:gpu-vm'
    ])
    expect(merged.branchGroup?.[0].hostLabel).toBe('Local Mac')
    expect(merged.branchGroup?.[1].worktree.id).toBe(remoteWorktree.id)
    expect(merged.branchGroup?.[1].repo?.id).toBe(remoteRepo.id)
  })

  it('keeps rows on one host as separate rows', () => {
    const first = itemRow({ worktree, rowKey: 'project:p1:wt-1' })
    const second = itemRow({
      worktree: { ...worktree, id: 'wt-1b', path: '/tmp/orca-feature-b' },
      rowKey: 'project:p1:wt-1b'
    })

    expect(merge([first, second])).toHaveLength(2)
  })

  it('leaves a single-host branch untouched', () => {
    const rows = [itemRow({ worktree })]
    expect(merge(rows)).toEqual(rows)
  })

  it('leaves a branch unmerged when one host has two checkouts of it', () => {
    const rows = [
      itemRow({ worktree, rowKey: 'project:p1:wt-1' }),
      itemRow({ worktree: { ...worktree, id: 'wt-1b' }, rowKey: 'project:p1:wt-1b' }),
      itemRow({ worktree: remoteWorktree, rowKey: 'project:p1:wt-remote' })
    ]

    expect(merge(rows)).toHaveLength(3)
  })

  it('never merges pinned-section rows', () => {
    const rows = [
      itemRow({ worktree, sectionKey: PINNED_GROUP_KEY }),
      itemRow({ worktree: remoteWorktree, sectionKey: PINNED_GROUP_KEY })
    ]

    expect(merge(rows)).toHaveLength(2)
  })

  it('never merges a lineage child row', () => {
    const rows = [itemRow({ worktree, depth: 1 }), itemRow({ worktree: remoteWorktree, depth: 1 })]

    expect(merge(rows)).toHaveLength(2)
  })

  it('never merges worktrees from different projects', () => {
    const orphan: Worktree = { ...worktree, id: 'wt-orphan', repoId: 'repo-orphan' }
    const rows = [
      itemRow({ worktree, sectionKey: 'project:p1' }),
      itemRow({ worktree: orphan, sectionKey: 'repo:repo-orphan' })
    ]

    expect(merge(rows)).toHaveLength(2)
  })

  it('skips detached-HEAD workspaces', () => {
    const detached: Worktree = { ...worktree, branch: '', head: 'abc1234' }
    const detachedRemote: Worktree = { ...remoteWorktree, branch: '', head: 'def5678' }
    const rows = [itemRow({ worktree: detached }), itemRow({ worktree: detachedRemote })]

    expect(merge(rows)).toHaveLength(2)
  })

  it('preserves non-worktree rows in place', () => {
    const header: Row = {
      type: 'header',
      key: 'project:p1',
      label: 'Project',
      count: 2,
      icon: { kind: 'project' }
    }
    const rows = [header, itemRow({ worktree }), itemRow({ worktree: remoteWorktree })]

    const result = merge(rows)

    expect(result).toHaveLength(2)
    expect(result[0]).toBe(header)
  })
})

const members: BranchGroupMember[] = [
  { worktree, repo, hostId: LOCAL_EXECUTION_HOST_ID, hostLabel: 'Local Mac' },
  { worktree: remoteWorktree, repo: remoteRepo, hostId: 'ssh:gpu-vm', hostLabel: 'GPU VM' }
]

describe('resolveBranchGroupSelection', () => {
  it('falls back to the local-first member with no selection or active workspace', () => {
    const result = resolveBranchGroupSelection({
      members,
      groupKey: 'r',
      selection: {},
      activeWorktreeId: null,
      activeExecutionHostId: null
    })

    expect(result.selectedHostId).toBe(LOCAL_EXECUTION_HOST_ID)
    expect(result.member.worktree.id).toBe(worktree.id)
    expect(result.isActiveGroup).toBe(false)
  })

  it('follows the active workspace host until the user picks one', () => {
    const result = resolveBranchGroupSelection({
      members,
      groupKey: 'r',
      selection: {},
      activeWorktreeId: remoteWorktree.id,
      activeExecutionHostId: 'ssh:gpu-vm'
    })

    expect(result.selectedHostId).toBe('ssh:gpu-vm')
    expect(result.member.worktree.id).toBe(remoteWorktree.id)
    expect(result.isActiveGroup).toBe(true)
  })

  it('lets an explicit choice win over the active workspace', () => {
    const selection: Record<string, ExecutionHostId> = { r: LOCAL_EXECUTION_HOST_ID }
    const result = resolveBranchGroupSelection({
      members,
      groupKey: 'r',
      selection,
      activeWorktreeId: remoteWorktree.id,
      activeExecutionHostId: 'ssh:gpu-vm'
    })

    expect(result.selectedHostId).toBe(LOCAL_EXECUTION_HOST_ID)
    expect(result.member.worktree.id).toBe(worktree.id)
    expect(result.isActiveGroup).toBe(false)
  })
})
