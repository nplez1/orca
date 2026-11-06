import { getWorktreeWatcherRemoval } from '../ipc/worktree-watcher-removal'
import { acquireWatcherRemovalGate } from '../ipc/watcher-removal-gate'
import {
  createWatcherRemovalDeadline,
  drainBeforeWatcherRemoval,
  type WatcherRemovalDeadline
} from '../ipc/watcher-removal-drain'

type FileExplorerWatcherCommands = {
  closeFileExplorerWatchersForPath(worktreePath: string, connectionId?: string): Promise<void>
  restoreFileExplorerWatchersAfterFailedRemoval(
    worktreePath: string,
    connectionId?: string
  ): Promise<void>
  forgetFileExplorerWatchersAfterRemoval(worktreePath: string, connectionId?: string): void
}

/** Restore is best-effort: a failed delete must still settle, even when installing on a locked tree hangs. */
export const WATCHER_RESTORE_BUDGET_MS = 15_000

export function createRuntimeFileWatcherRemoval(fileCommands: FileExplorerWatcherCommands) {
  const close = async (
    worktreePath: string,
    connectionId?: string,
    deadline: WatcherRemovalDeadline = createWatcherRemovalDeadline()
  ): Promise<void> => {
    // Desktop watchers own local roots; SSH paths have no local watcher to close.
    const results = await Promise.allSettled([
      connectionId ? undefined : getWorktreeWatcherRemoval().closeLocal(worktreePath, deadline),
      drainBeforeWatcherRemoval(
        fileCommands.closeFileExplorerWatchersForPath(worktreePath, connectionId),
        deadline,
        `file explorer watcher close for ${worktreePath}`
      )
    ])
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (failure) {
      // Wait for all bounded teardowns before restoring watchers.
      throw failure.reason
    }
  }

  // Why bounded: this runs in the removal's `finally`, so an unsettled restore would hold the
  // workspace in Deleting forever on exactly the tree the delete could not empty.
  const restore = async (
    worktreePath: string,
    connectionId?: string,
    deadline: WatcherRemovalDeadline = createWatcherRemovalDeadline(WATCHER_RESTORE_BUDGET_MS)
  ): Promise<void> => {
    await Promise.all([
      connectionId
        ? undefined
        : drainBeforeWatcherRemoval(
            getWorktreeWatcherRemoval().restoreLocal(worktreePath),
            deadline,
            `local watcher restore for ${worktreePath}`
          ),
      drainBeforeWatcherRemoval(
        fileCommands.restoreFileExplorerWatchersAfterFailedRemoval(worktreePath, connectionId),
        deadline,
        `file explorer watcher restore for ${worktreePath}`
      )
    ])
  }

  const forget = (worktreePath: string, connectionId?: string): void => {
    if (!connectionId) {
      getWorktreeWatcherRemoval().forgetLocal(worktreePath)
    }
    fileCommands.forgetFileExplorerWatchersAfterRemoval(worktreePath, connectionId)
  }

  const acquire = async (
    worktreePath: string,
    connectionId?: string
  ): Promise<{ finish(removed: boolean): Promise<void> }> => {
    const gate = acquireWatcherRemovalGate(worktreePath, connectionId)
    const deadline = createWatcherRemovalDeadline()
    try {
      await close(worktreePath, connectionId, deadline)
      const fenceDrain = await drainBeforeWatcherRemoval(
        gate.ready,
        deadline,
        `watcher install fence for ${worktreePath}`
      )
      if (fenceDrain === 'timeout') {
        gate.abandonPendingInstalls()
      }
      await close(worktreePath, connectionId, deadline)
      let finished = false
      return {
        finish: async (removed) => {
          if (finished) {
            return
          }
          finished = true
          if (removed) {
            forget(worktreePath, connectionId)
          }
          gate.release()
          if (!removed) {
            await restore(worktreePath, connectionId).catch((restoreError: unknown) => {
              console.error('[worktrees] failed to restore watchers after removal failed', {
                worktreePath,
                restoreError
              })
            })
          }
        }
      }
    } catch (error) {
      gate.release()
      await restore(worktreePath, connectionId).catch((restoreError: unknown) => {
        console.error('[worktrees] failed to restore watchers after removal setup failed', {
          worktreePath,
          restoreError
        })
      })
      throw error
    }
  }

  return { close, restore, forget, acquire }
}
