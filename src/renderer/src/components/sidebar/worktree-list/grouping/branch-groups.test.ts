import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host/execution-host'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { resolveBranchGroupSelection } from './branch-groups'
import { indexLineageFoldKeys, mergeSameBranchRows } from './same-branch-row-merge'
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

function worktreeOn(base: Worktree, id: string, branch: string): Worktree {
  return { ...base, id, branch }
}

function rowFor(
  parent: Worktree,
  overrides: Partial<WorktreeRow> = {},
  options: { childIds?: readonly string[] } = {}
): WorktreeRow {
  const childIds = options.childIds ?? []
  return itemRow({
    worktree: parent,
    rowKey: `project:p1:${parent.id}`,
    lineageChildCount: childIds.length,
    ...(childIds.length > 0
      ? {
          lineageChildWorktreeIds: childIds,
          lineageGroupKey: getWorktreeLineageGroupKey(parent),
          lineageCollapsed: false
        }
      : {}),
    ...overrides
  })
}

function rowKeys(rows: readonly Row[]): string[] {
  return rows.map((row) => (row.type === 'item' ? row.rowKey : row.type))
}

function itemAt(rows: readonly Row[], index: number): WorktreeRow {
  const row = rows[index]
  if (row.type !== 'item') {
    throw new Error(`expected an item row at ${index}`)
  }
  return row
}

describe('mergeSameBranchRows with lineage children', () => {
  const localChild = rowFor(
    worktreeOn(worktree, 'wt-1-child', 'child'),
    { depth: 1 },
    {
      childIds: ['wt-1-grandchild']
    }
  )
  const remoteChildA = rowFor(worktreeOn(remoteWorktree, 'wt-remote-child-a', 'child-a'), {
    depth: 1
  })
  const remoteChildB = rowFor(worktreeOn(remoteWorktree, 'wt-remote-child-b', 'child-b'), {
    depth: 1
  })
  const localParent = rowFor(worktree, {}, { childIds: ['wt-1-child'] })
  const remoteParent = rowFor(
    remoteWorktree,
    {},
    {
      childIds: ['wt-remote-child-a', 'wt-remote-child-b']
    }
  )

  it('stacks the hosts even when one side has children', () => {
    const result = merge([localParent, localChild, remoteParent, remoteChildA, remoteChildB])

    expect(result).toHaveLength(4)
    const merged = itemAt(result, 0)
    expect(merged.worktree.id).toBe(worktree.id)
    expect(merged.branchGroup?.map((member) => member.hostId)).toEqual([
      LOCAL_EXECUTION_HOST_ID,
      'ssh:gpu-vm'
    ])
    expect(rowKeys(result).slice(1)).toEqual([
      localChild.rowKey,
      remoteChildA.rowKey,
      remoteChildB.rowKey
    ])
  })

  it('carries the union of every member child under the merged card', () => {
    const result = merge([localParent, localChild, remoteParent, remoteChildA, remoteChildB])
    const merged = itemAt(result, 0)

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
    const result = merge([remoteParent, remoteChildA, remoteChildB, localParent, localChild])

    expect(rowKeys(result)).toEqual([
      localParent.rowKey,
      localChild.rowKey,
      remoteChildA.rowKey,
      remoteChildB.rowKey
    ])
  })

  it('keeps the union count when the only children sit on the non-primary host', () => {
    const childlessLocal = rowFor(worktree)
    const result = merge([childlessLocal, remoteParent, remoteChildA, remoteChildB])
    const merged = itemAt(result, 0)

    expect(result).toHaveLength(3)
    expect(merged.lineageChildCount).toBe(2)
    expect(merged.lineageGroupKey).toBe(getWorktreeLineageGroupKey(remoteWorktree))
    expect(merged.lineageCollapseKeys).toEqual([getWorktreeLineageGroupKey(remoteWorktree)])
  })

  it('folds every member child when the card is collapsed', () => {
    const rows = [localParent, localChild, remoteParent, remoteChildA, remoteChildB]
    const result = merge(rows, new Set([LOCAL_PARENT_GROUP]))

    expect(result).toHaveLength(1)
    const merged = itemAt(result, 0)
    expect(merged.lineageCollapsed).toBe(true)
    expect(merged.lineageChildCount).toBe(3)
  })

  it('treats any collapsed member as the whole card folded', () => {
    const rows = [localParent, localChild, remoteParent, remoteChildA, remoteChildB]

    expect(merge(rows, new Set([REMOTE_PARENT_GROUP]))).toHaveLength(1)
  })
})

describe('mergeSameBranchRows with the same hierarchy on both hosts', () => {
  const localMid = rowFor(
    worktreeOn(worktree, 'wt-m5-mid', 'feature'),
    { depth: 1 },
    {
      childIds: ['wt-m5-leaf']
    }
  )
  const localLeaf = rowFor(worktreeOn(worktree, 'wt-m5-leaf', 'feature-ui'), { depth: 2 })
  const remoteMid = rowFor(
    worktreeOn(remoteWorktree, 'wt-win-mid', 'feature'),
    { depth: 1 },
    {
      childIds: ['wt-win-leaf']
    }
  )
  const remoteLeaf = rowFor(worktreeOn(remoteWorktree, 'wt-win-leaf', 'feature-ui'), { depth: 2 })
  const localRoot = rowFor(worktree, {}, { childIds: ['wt-m5-mid'] })
  const remoteRoot = rowFor(remoteWorktree, {}, { childIds: ['wt-win-mid'] })
  const rowsWithLeaves = [localRoot, localMid, localLeaf, remoteRoot, remoteMid, remoteLeaf]

  it('draws one hierarchy, not one per host', () => {
    const result = merge(rowsWithLeaves)

    expect(result).toHaveLength(3)
    expect(result.map((row) => (row.type === 'item' ? row.depth : row.type))).toEqual([0, 1, 2])
  })

  it('gives every workspace in the hierarchy its own host dropdown', () => {
    const result = merge(rowsWithLeaves)

    for (const row of result) {
      const merged = itemAt(result, result.indexOf(row))
      expect(merged.branchGroup?.map((member) => member.hostId)).toEqual([
        LOCAL_EXECUTION_HOST_ID,
        'ssh:gpu-vm'
      ])
      expect(merged.branchGroupKey).toBeTruthy()
    }
  })

  it('counts the cards it draws, not the workspaces behind them', () => {
    const result = merge(rowsWithLeaves)

    expect(itemAt(result, 0).lineageChildCount).toBe(1)
    expect(itemAt(result, 0).lineageChildWorktreeIds).toEqual(['wt-m5-mid', 'wt-win-mid'])
    expect(itemAt(result, 1).lineageChildWorktreeIds).toEqual(['wt-m5-leaf', 'wt-win-leaf'])
    expect(itemAt(result, 2).lineageChildCount).toBe(0)
  })

  it('keeps the child list the same whichever host a card shows', () => {
    const result = merge(rowsWithLeaves)
    const root = itemAt(result, 0)
    const members = root.branchGroup ?? []

    const perHost = members.map((member) =>
      resolveBranchGroupSelection({
        members,
        groupKey: root.branchGroupKey ?? '',
        selection: { [root.branchGroupKey ?? '']: member.hostId },
        activeWorktreeId: null,
        activeExecutionHostId: null
      })
    )

    expect(perHost.map((selection) => selection.selectedHostId)).toEqual([
      LOCAL_EXECUTION_HOST_ID,
      'ssh:gpu-vm'
    ])
    expect(root.lineageChildWorktreeIds).toEqual(['wt-m5-mid', 'wt-win-mid'])
    expect(rowKeys(result).slice(1)).toEqual([localMid.rowKey, localLeaf.rowKey])
  })

  it('indexes every nested card member to the groups that card folds', () => {
    const index = indexLineageFoldKeys(merge(rowsWithLeaves))
    const midGroups = [
      getWorktreeLineageGroupKey(localMid.worktree),
      getWorktreeLineageGroupKey(remoteMid.worktree)
    ]

    for (const group of midGroups) {
      expect(index.get(group)).toEqual(midGroups)
    }
    expect(index.get(getWorktreeLineageGroupKey(localLeaf.worktree))).toBeUndefined()
  })

  it('folds a nested card without folding its parent', () => {
    const midGroup = getWorktreeLineageGroupKey(localMid.worktree)
    const result = merge(rowsWithLeaves, new Set([midGroup]))

    expect(rowKeys(result)).toEqual([localRoot.rowKey, localMid.rowKey])
    expect(itemAt(result, 1).lineageCollapsed).toBe(true)
  })
})

describe('mergeSameBranchRows with children on different branches', () => {
  const localChild = rowFor(
    worktreeOn(worktree, 'wt-1-child', 'child'),
    { depth: 1 },
    {
      childIds: ['wt-1-grandchild']
    }
  )
  const localGrandchild = rowFor(worktreeOn(worktree, 'wt-1-grandchild', 'child-ui'), {
    depth: 2,
    isLastLineageChild: true
  })
  const remoteChild = rowFor(
    worktreeOn(remoteWorktree, 'wt-remote-child', 'other-child'),
    {
      depth: 1
    },
    { childIds: ['wt-remote-grandchild'] }
  )
  const remoteGrandchild = rowFor(
    worktreeOn(remoteWorktree, 'wt-remote-grandchild', 'other-child-ui'),
    { depth: 2, isLastLineageChild: true }
  )
  const localParent = rowFor(worktree, {}, { childIds: ['wt-1-child'] })
  const remoteParent = rowFor(remoteWorktree, {}, { childIds: ['wt-remote-child'] })

  it('moves a grandchild chain with the other host subtree', () => {
    const result = merge([
      remoteParent,
      remoteChild,
      remoteGrandchild,
      localParent,
      localChild,
      localGrandchild
    ])

    expect(rowKeys(result)).toEqual([
      localParent.rowKey,
      localChild.rowKey,
      localGrandchild.rowKey,
      remoteChild.rowKey,
      remoteGrandchild.rowKey
    ])
  })

  it('carries the moved rows themselves, so depth and tree flags survive', () => {
    const result = merge([
      localParent,
      localChild,
      localGrandchild,
      remoteParent,
      remoteChild,
      remoteGrandchild
    ])

    expect(result[3]).toBe(remoteChild)
    expect(result[4]).toBe(remoteGrandchild)
  })

  it('unions the counts of both hosts when both sides nest', () => {
    const result = merge([
      localParent,
      localChild,
      localGrandchild,
      remoteParent,
      remoteChild,
      remoteGrandchild
    ])

    expect(itemAt(result, 0).lineageChildCount).toBe(2)
    expect(itemAt(result, 0).lineageChildWorktreeIds).toEqual(['wt-1-child', 'wt-remote-child'])
  })

  it('moves a three-deep chain intact', () => {
    const greatGrandchild = rowFor(
      worktreeOn(remoteWorktree, 'wt-remote-great', 'other-child-ui-x'),
      { depth: 3, isLastLineageChild: true }
    )
    const result = merge([
      localParent,
      localChild,
      localGrandchild,
      remoteParent,
      remoteChild,
      remoteGrandchild,
      greatGrandchild
    ])

    expect(result.map((row) => (row.type === 'item' ? row.depth : row.type))).toEqual([
      0, 1, 2, 1, 2, 3
    ])
    expect(result[5]).toBe(greatGrandchild)
  })

  it('leaves rows that follow the moved subtree where they were', () => {
    const other = itemRow({ worktree: worktreeOn(worktree, 'wt-other', 'other') })
    const result = merge([
      remoteParent,
      remoteChild,
      remoteGrandchild,
      localParent,
      localChild,
      localGrandchild,
      other
    ])

    expect(rowKeys(result)).toEqual([
      localParent.rowKey,
      localChild.rowKey,
      localGrandchild.rowKey,
      remoteChild.rowKey,
      remoteGrandchild.rowKey,
      other.rowKey
    ])
  })

  it('draws the card where the primary row sat, not at the other host', () => {
    const other = itemRow({ worktree: worktreeOn(worktree, 'wt-other', 'other') })
    const result = merge([
      remoteParent,
      remoteChild,
      remoteGrandchild,
      other,
      localParent,
      localChild,
      localGrandchild
    ])

    expect(rowKeys(result)).toEqual([
      other.rowKey,
      localParent.rowKey,
      localChild.rowKey,
      localGrandchild.rowKey,
      remoteChild.rowKey,
      remoteGrandchild.rowKey
    ])
  })

  it('folds the grandchildren too when the card is collapsed', () => {
    const result = merge(
      [localParent, localChild, localGrandchild, remoteParent, remoteChild, remoteGrandchild],
      new Set([REMOTE_PARENT_GROUP])
    )

    expect(result).toHaveLength(1)
  })

  it('keeps both rows when one workspace nests under a parent on each host', () => {
    const sharedLocal = rowFor(worktreeOn(worktree, 'wt-shared-child', 'shared-child'), {
      depth: 1
    })
    const sharedRemote = rowFor(worktreeOn(remoteWorktree, 'wt-shared-child', 'shared-child'), {
      depth: 1
    })
    const localHostParent = rowFor(worktree, {}, { childIds: ['wt-shared-child'] })
    const remoteHostParent = rowFor(remoteWorktree, {}, { childIds: ['wt-shared-child'] })
    const result = merge([remoteHostParent, sharedRemote, localHostParent, sharedLocal])

    expect(rowKeys(result)).toEqual([
      localHostParent.rowKey,
      sharedLocal.rowKey,
      sharedRemote.rowKey
    ])
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

  it('never merges a child with its parent', () => {
    const rows = [itemRow({ worktree }), itemRow({ worktree: remoteWorktree, depth: 1 })]

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
