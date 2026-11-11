import { getWorkspaceStatus } from '../../../../../../shared/workspace-statuses'
import type {
  WorkspaceStatus,
  WorkspaceStatusDefinition,
  Worktree
} from '../../../../../../shared/worktree/types'

export type WorkspaceBoardTaskStatusSyncRequest = {
  worktreeKeys: string[]
  targetStatus: WorkspaceStatusDefinition
}

/** The cards a board move has to sync, or `null` when the toggle is off, no card changed, or the
 *  target status is unknown. Kept apart from the sync itself: this is the only pure decision a move
 *  makes before any provider is touched, and the sync module is at its line budget. */
export function getWorkspaceBoardTaskStatusSyncRequest(args: {
  enabled: boolean
  worktreeKeys: readonly string[]
  status: WorkspaceStatus
  worktreesByKey: ReadonlyMap<string, Pick<Worktree, 'workspaceStatus'>>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
}): WorkspaceBoardTaskStatusSyncRequest | null {
  if (!args.enabled || args.worktreeKeys.length === 0) {
    return null
  }
  const targetStatus = args.workspaceStatuses.find((item) => item.id === args.status)
  if (!targetStatus) {
    return null
  }
  const changedWorktreeKeys = [...new Set(args.worktreeKeys)].filter((key) => {
    const worktree = args.worktreesByKey.get(key)
    return worktree ? getWorkspaceStatus(worktree, args.workspaceStatuses) !== args.status : false
  })
  if (changedWorktreeKeys.length === 0) {
    return null
  }
  return { worktreeKeys: changedWorktreeKeys, targetStatus }
}
