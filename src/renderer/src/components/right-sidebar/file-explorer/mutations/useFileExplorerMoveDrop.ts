import { useCallback } from 'react'
import { toast } from 'sonner'
import { basename, dirname, joinPath } from '@/lib/path'
import { executeOpenEditorPathMove } from '@/lib/editor/file-operations/execute-open-editor-path-move'
import { runtimePathExists } from '@/runtime/files/metadata/runtime-file-metadata-client'
import { commitFileExplorerOp } from './fileExplorerUndoRedo'
import type { FileExplorerOperationOwner } from '../tree/file-explorer-types'
import { captureFileExplorerOperationGuard } from '../navigation/file-explorer-operation-owner'
import { classifyMoveDestination } from './file-explorer-move-copy-paths'
import { fileExplorerGuardContext } from './file-explorer-copy-into-dir'
import { translate } from '@/i18n/i18n'

/** Strip Electron invoke error wrappers before showing the underlying message. */
export function extractIpcErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) {
    return fallback
  }
  const match = err.message.match(/Error invoking remote method '[^']*': (?:Error: )?(.+)/)
  return match ? match[1] : err.message
}

export function isPathCollisionError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message.includes('EEXIST') ||
      err.message.includes('ENOTEMPTY') ||
      err.message.includes('already exists'))
  )
}

export function pathCollisionMessage(name: string): string {
  return translate(
    'fileExplorer.moveCopy.collision',
    "An item named '{{name}}' already exists in that folder.",
    { name }
  )
}

function describeMoveFailure(err: unknown, fileName: string): string {
  return isPathCollisionError(err)
    ? pathCollisionMessage(fileName)
    : extractIpcErrorMessage(
        err,
        translate('components.toastFallbacks.fileMoveFailed', "Failed to move '{{name}}'.", {
          name: fileName
        })
      )
}

export type FileExplorerMoveResult =
  | { status: 'moved' }
  | { status: 'skipped' }
  | { status: 'failed'; message: string }

type UseFileExplorerMovePathParams = {
  worktreePath: string | null
  activeWorktreeId: string | null
  refreshDir: (dirPath: string) => Promise<void>
  getOperationOwnerForPath: (path: string) => FileExplorerOperationOwner | undefined
}

/** One explorer move: editor-tab rekeying, rollback and an undo entry, shared by drag-drop and "Move to…". */
export function useFileExplorerMovePath({
  worktreePath,
  activeWorktreeId,
  refreshDir,
  getOperationOwnerForPath
}: UseFileExplorerMovePathParams): (
  sourcePath: string,
  destDir: string
) => Promise<FileExplorerMoveResult> {
  return useCallback(
    async (sourcePath: string, destDir: string): Promise<FileExplorerMoveResult> => {
      if (!worktreePath || !activeWorktreeId) {
        return { status: 'skipped' }
      }
      if (classifyMoveDestination(sourcePath, destDir) !== 'allowed') {
        return { status: 'skipped' }
      }
      const fileName = basename(sourcePath),
        sourceDir = dirname(sourcePath)
      const newPath = joinPath(destDir, fileName)
      const operationOwner = getOperationOwnerForPath(sourcePath)

      try {
        const operationGuard = captureFileExplorerOperationGuard(activeWorktreeId, operationOwner)
        const context = fileExplorerGuardContext(operationGuard, activeWorktreeId, worktreePath)
        // Hosts word no-clobber refusals differently; checking first names the real cause.
        if (await runtimePathExists(context, newPath)) {
          return { status: 'failed', message: pathCollisionMessage(fileName) }
        }
        operationGuard.assertCurrent()
        await executeOpenEditorPathMove({
          context,
          fromPath: sourcePath,
          toPath: newPath,
          worktreeId: activeWorktreeId,
          worktreePath
        })
        commitFileExplorerOp({
          undo: async () => {
            operationGuard.assertCurrent()
            await executeOpenEditorPathMove({
              context,
              fromPath: newPath,
              toPath: sourcePath,
              worktreeId: activeWorktreeId,
              worktreePath
            })
            await Promise.all([refreshDir(destDir), refreshDir(sourceDir)])
          },
          redo: async () => {
            operationGuard.assertCurrent()
            await executeOpenEditorPathMove({
              context,
              fromPath: sourcePath,
              toPath: newPath,
              worktreeId: activeWorktreeId,
              worktreePath
            })
            await Promise.all([refreshDir(sourceDir), refreshDir(destDir)])
          }
        })
      } catch (err) {
        return { status: 'failed', message: describeMoveFailure(err, fileName) }
      }
      // A refresh failure must not report a completed move as failed.
      await Promise.all([refreshDir(sourceDir), refreshDir(destDir)]).catch(() => {})
      return { status: 'moved' }
    },
    [worktreePath, activeWorktreeId, refreshDir, getOperationOwnerForPath]
  )
}

type UseFileExplorerMoveDropParams = {
  movePath: (sourcePath: string, destDir: string) => Promise<FileExplorerMoveResult>
  setDropTargetDir: (dir: string | null) => void
}

export function useFileExplorerMoveDrop({
  movePath,
  setDropTargetDir
}: UseFileExplorerMoveDropParams): (sourcePath: string, destDir: string) => void {
  return useCallback(
    (sourcePath: string, destDir: string) => {
      setDropTargetDir(null)
      void movePath(sourcePath, destDir).then((result) => {
        if (result.status === 'failed') {
          toast.error(result.message)
        }
      })
    },
    [movePath, setDropTargetDir]
  )
}
