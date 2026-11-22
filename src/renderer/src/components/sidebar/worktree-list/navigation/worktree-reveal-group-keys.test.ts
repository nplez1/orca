import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { getWorktreeLineageGroupKey } from '../../../../../../shared/sidebar-list/sections/group-keys'
import type {
  WorktreeOccurrence,
  WorktreeOccurrencePlan
} from '../../../../../../shared/sidebar-list/lineage/worktree-occurrence-plan'
import { getWorktreeRevealCollapsedGroupKeys } from './worktree-reveal-group-keys'
import {
  project,
  projectHostSetups,
  remoteRepo,
  remoteWorktree,
  repo,
  worktree
} from '../grouping/worktree-list-groups-test-fixtures'

const remoteHostId: ExecutionHostId = remoteWorktree.hostId ?? 'ssh:gpu-vm'

function onHost(base: Worktree, hostId: ExecutionHostId, id: string, branch: string): Worktree {
  return {
    ...base,
    id,
    branch,
    hostId,
    repoId: hostId === LOCAL_EXECUTION_HOST_ID ? repo.id : remoteRepo.id
  }
}

// One three-level hierarchy on both hosts, the same branches at every level.
const m5Root = worktree
const m5Mid = onHost(worktree, LOCAL_EXECUTION_HOST_ID, 'wt-m5-mid', 'feature')
const m5Leaf = onHost(worktree, LOCAL_EXECUTION_HOST_ID, 'wt-m5-leaf', 'feature-ui')
const winRoot = remoteWorktree
const winMid = onHost(remoteWorktree, remoteHostId, 'wt-win-mid', 'feature')
const winLeaf = onHost(remoteWorktree, remoteHostId, 'wt-win-leaf', 'feature-ui')

const parentsByChild: Record<string, Worktree> = {
  [getWorktreeHostIdentity(m5Mid)]: m5Root,
  [getWorktreeHostIdentity(m5Leaf)]: m5Mid,
  [getWorktreeHostIdentity(winMid)]: winRoot,
  [getWorktreeHostIdentity(winLeaf)]: winMid
}

function occurrenceKey(worktree: Worktree): string {
  return `project:p1:${getWorktreeHostIdentity(worktree)}`
}

function planFor(worktrees: readonly Worktree[]): WorktreeOccurrencePlan<Worktree> {
  const byIdentity = new Map<string, WorktreeOccurrence<Worktree>>()
  for (const row of worktrees) {
    byIdentity.set(getWorktreeHostIdentity(row), {
      key: occurrenceKey(row),
      row,
      sectionKey: 'project:p1',
      placement: 'natural',
      sectionPath: { key: 'project:p1' },
      depth: 0,
      childCount: 0,
      isLastChild: false,
      showProjectName: false
    })
  }
  for (const row of worktrees) {
    const parent = parentsByChild[getWorktreeHostIdentity(row)]
    const occurrence = byIdentity.get(getWorktreeHostIdentity(row))
    if (!parent || !occurrence) {
      continue
    }
    occurrence.parent = byIdentity.get(getWorktreeHostIdentity(parent))
    occurrence.depth = 1
  }
  return {
    preferredByIdentity: byIdentity,
    bySection: new Map([['project:p1', [...byIdentity.values()]]])
  }
}

const repoMap = new Map([
  [repo.id, repo],
  [remoteRepo.id, remoteRepo]
])
const worktrees = [m5Root, m5Mid, m5Leaf, winRoot, winMid, winLeaf]

function revealKeys(target: Worktree, collapsed: ReadonlySet<string>): string[] {
  return getWorktreeRevealCollapsedGroupKeys({
    occurrencePlan: planFor(worktrees),
    worktree: target,
    worktrees,
    worktreeLineageById: {},
    repoMap,
    defaultHostId: LOCAL_EXECUTION_HOST_ID,
    hostScopedGroups: false,
    collapsedGroups: collapsed,
    groupBy: 'repo',
    pinnedDisplayPolicy: 'single-location',
    prCache: null,
    workspaceStatuses: [],
    projectGroups: [],
    projectGrouping: { projects: [project], projectHostSetups },
    mergeSameBranchCards: true
  })
}

describe('getWorktreeRevealCollapsedGroupKeys with a merged hierarchy', () => {
  it('unfolds every key of a nested card, not just the target host own', () => {
    const midGroups = [getWorktreeLineageGroupKey(m5Mid), getWorktreeLineageGroupKey(winMid)]

    // The mid card is folded on both hosts and its leaf is revealed: both keys go.
    expect(revealKeys(winLeaf, new Set(midGroups))).toEqual(midGroups)
  })

  it('unfolds a folded root card that holds the target', () => {
    const rootGroups = [getWorktreeLineageGroupKey(m5Root), getWorktreeLineageGroupKey(winRoot)]

    expect(revealKeys(m5Leaf, new Set(rootGroups))).toEqual(rootGroups)
  })

  it('leaves keys alone when no merge happened', () => {
    const collapsed = new Set([
      getWorktreeLineageGroupKey(m5Mid),
      getWorktreeLineageGroupKey(winMid)
    ])

    expect(
      getWorktreeRevealCollapsedGroupKeys({
        occurrencePlan: planFor(worktrees),
        worktree: winLeaf,
        worktrees,
        worktreeLineageById: {},
        repoMap,
        defaultHostId: LOCAL_EXECUTION_HOST_ID,
        hostScopedGroups: false,
        collapsedGroups: collapsed,
        groupBy: 'none',
        pinnedDisplayPolicy: 'single-location',
        prCache: null,
        workspaceStatuses: [],
        projectGroups: [],
        projectGrouping: { projects: [project], projectHostSetups },
        mergeSameBranchCards: false
      })
    ).toEqual([getWorktreeLineageGroupKey(winMid)])
  })
})
