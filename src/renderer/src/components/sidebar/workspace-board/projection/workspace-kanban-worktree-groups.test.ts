import { describe, expect, it } from 'vitest'
import type { WorkspaceStatusDefinition } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { groupHiddenWorkspaceKanbanWorktrees } from './workspace-kanban-worktree-groups'

const STATUSES: readonly WorkspaceStatusDefinition[] = [
  { id: 'in-progress', label: 'In progress' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' }
]

function hiddenIds(
  params: Parameters<typeof groupHiddenWorkspaceKanbanWorktrees>[0]
): Record<string, string[]> {
  return Object.fromEntries(
    Array.from(groupHiddenWorkspaceKanbanWorktrees(params)).map(([status, items]) => [
      status,
      items.map((worktree) => worktree.id)
    ])
  )
}

describe('groupHiddenWorkspaceKanbanWorktrees', () => {
  it('buckets the members the filters hide by their own status', () => {
    const asleep = makeWorktree({ id: 'sleeping', repoId: 'repo', workspaceStatus: 'in-progress' })
    const shown = makeWorktree({ id: 'shown', repoId: 'repo', workspaceStatus: 'in-progress' })
    const parked = makeWorktree({ id: 'parked', repoId: 'repo', workspaceStatus: 'done' })

    expect(
      hiddenIds({
        worktrees: [asleep, shown, parked],
        visibleWorktreeIds: new Set([getWorktreeHostIdentity(shown)]),
        workspaceStatuses: STATUSES
      })
    ).toEqual({ 'in-progress': ['sleeping'], review: [], done: ['parked'] })
  })

  it('never counts an archived workspace, which no filter can reveal', () => {
    const archived = makeWorktree({
      id: 'archived',
      repoId: 'repo',
      workspaceStatus: 'review',
      isArchived: true
    })

    expect(
      hiddenIds({
        worktrees: [archived],
        visibleWorktreeIds: new Set(),
        workspaceStatuses: STATUSES
      })
    ).toEqual({ 'in-progress': [], review: [], done: [] })
  })

  it('keeps two hosts copies of one workspace apart', () => {
    const localCopy = makeWorktree({ id: 'wt', repoId: 'repo', hostId: 'local' })
    const remoteCopy = makeWorktree({ id: 'wt', repoId: 'repo', hostId: 'ssh:other' })

    expect(
      hiddenIds({
        worktrees: [localCopy, remoteCopy],
        visibleWorktreeIds: new Set([getWorktreeHostIdentity(localCopy)]),
        workspaceStatuses: STATUSES
      })
    ).toEqual({ 'in-progress': ['wt'], review: [], done: [] })
  })

  it('files a workspace whose status is no longer offered under the default status', () => {
    const stale = makeWorktree({ id: 'stale', repoId: 'repo', workspaceStatus: 'deleted-status' })

    expect(
      hiddenIds({
        worktrees: [stale],
        visibleWorktreeIds: new Set(),
        workspaceStatuses: STATUSES
      })
    ).toEqual({ 'in-progress': ['stale'], review: [], done: [] })
  })
})
