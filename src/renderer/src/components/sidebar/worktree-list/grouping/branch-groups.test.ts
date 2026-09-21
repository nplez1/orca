import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { mergeSameBranchRows, resolveBranchGroupSelection } from './branch-groups'
import { buildProjectGroupingIndex } from './project-grouping'
import { PINNED_GROUP_KEY } from './group-keys'
import type { BranchGroupMember, Row, WorktreeRow } from './row-types'
import {
  project,
  projectHostSetups,
  remoteRepo,
  remoteWorktree,
  repo,
  worktree
} from '../../worktree-list-groups-test-fixtures'

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
    lineageTrail: [],
    isLastLineageChild: false,
    lineageChildCount: 0,
    ...overrides
  }
}

const hostLabels = new Map([
  [LOCAL_EXECUTION_HOST_ID, 'Local Mac'],
  ['ssh:gpu-vm', 'GPU VM']
])

function merge(rows: readonly Row[]): Row[] {
  return mergeSameBranchRows(
    rows,
    projectRepoMap,
    projectIndex,
    LOCAL_EXECUTION_HOST_ID,
    hostLabels
  )
}

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

  it('never merges a lineage parent or child', () => {
    const rows = [
      itemRow({ worktree, lineageChildCount: 2 }),
      itemRow({ worktree: remoteWorktree, depth: 1 })
    ]

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
      tone: 'text-foreground'
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
