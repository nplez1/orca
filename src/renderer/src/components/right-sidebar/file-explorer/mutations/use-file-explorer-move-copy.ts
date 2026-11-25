import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { basename, dirname } from '@/lib/path'
import { translate } from '@/i18n/i18n'
import type { TreeNode } from '../tree/file-explorer-types'
import { captureFileExplorerOperationGuard } from '../navigation/file-explorer-operation-owner'
import { copyFileIntoDir, fileExplorerGuardContext } from './file-explorer-copy-into-dir'
import { outermostPaths } from './file-explorer-move-copy-paths'
import { extractIpcErrorMessage, type FileExplorerMoveResult } from './useFileExplorerMoveDrop'

export type FileExplorerMoveCopyMode = 'move' | 'copy'

export type FileExplorerMoveCopyRequest = {
  mode: FileExplorerMoveCopyMode
  sources: TreeNode[]
  /** Folder the chooser opens on: the right-clicked item's parent. */
  startDir: string
  /** Workspace the request was made in; switching away drops it. */
  worktreeId: string | null
}

type UseFileExplorerMoveCopyParams = {
  activeWorktreeId: string | null
  worktreePath: string | null
  selectedPaths: Set<string>
  selectedNodes: TreeNode[]
  movePath: (sourcePath: string, destDir: string) => Promise<FileExplorerMoveResult>
  refreshDir: (dirPath: string) => Promise<void>
}

export type UseFileExplorerMoveCopyResult = {
  moveCopyRequest: FileExplorerMoveCopyRequest | null
  handleMoveTo: (node: TreeNode) => void
  handleCopyTo: (node: TreeNode) => void
  canCopyTo: (node: TreeNode) => boolean
  closeMoveCopy: () => void
  submitMoveCopy: (destDir: string) => void
}

function reportFailures(mode: FileExplorerMoveCopyMode, failures: string[], total: number): void {
  if (failures.length === 0) {
    return
  }
  if (failures.length === 1) {
    toast.error(failures[0])
    return
  }
  const title =
    mode === 'move'
      ? translate(
          'fileExplorer.moveCopy.moveFailedSummary',
          "Couldn't move {{failed}} of {{total}} items.",
          {
            failed: failures.length,
            total
          }
        )
      : translate(
          'fileExplorer.moveCopy.copyFailedSummary',
          "Couldn't copy {{failed}} of {{total}} items.",
          {
            failed: failures.length,
            total
          }
        )
  toast.error(title, { description: failures.join('\n') })
}

/** "Move to…"/"Copy to…": acts on the selection when the right-clicked row is part of it, like Delete. */
export function useFileExplorerMoveCopy({
  activeWorktreeId,
  worktreePath,
  selectedPaths,
  selectedNodes,
  movePath,
  refreshDir
}: UseFileExplorerMoveCopyParams): UseFileExplorerMoveCopyResult {
  const [pendingRequest, setPendingRequest] = useState<FileExplorerMoveCopyRequest | null>(null)
  const moveCopyRequest = pendingRequest?.worktreeId === activeWorktreeId ? pendingRequest : null

  const targetsFor = useCallback(
    (node: TreeNode): TreeNode[] =>
      selectedPaths.has(node.path) && selectedNodes.length > 1 ? selectedNodes : [node],
    [selectedPaths, selectedNodes]
  )

  const handleMoveTo = useCallback(
    (node: TreeNode) => {
      const targets = targetsFor(node)
      const keep = new Set(outermostPaths(targets.map((target) => target.path)))
      setPendingRequest({
        mode: 'move',
        sources: targets.filter((target) => keep.has(target.path)),
        startDir: dirname(node.path),
        worktreeId: activeWorktreeId
      })
    },
    [activeWorktreeId, targetsFor]
  )

  // Why files only: the host copy is a single-file copyFile; folders need a recursive copy it lacks.
  const canCopyTo = useCallback(
    (node: TreeNode) => targetsFor(node).every((target) => !target.isDirectory),
    [targetsFor]
  )

  const handleCopyTo = useCallback(
    (node: TreeNode) => {
      if (!canCopyTo(node)) {
        return
      }
      setPendingRequest({
        mode: 'copy',
        sources: targetsFor(node),
        startDir: dirname(node.path),
        worktreeId: activeWorktreeId
      })
    },
    [activeWorktreeId, canCopyTo, targetsFor]
  )

  const closeMoveCopy = useCallback(() => setPendingRequest(null), [])

  const runMove = useCallback(
    async (sources: TreeNode[], destDir: string) => {
      const failures: string[] = []
      // Sequential, so each move's undo entry and refresh land in order.
      for (const source of sources) {
        const result = await movePath(source.path, destDir)
        if (result.status === 'failed') {
          failures.push(result.message)
        }
      }
      reportFailures('move', failures, sources.length)
    },
    [movePath]
  )

  const runCopy = useCallback(
    async (sources: TreeNode[], destDir: string) => {
      if (!worktreePath) {
        return
      }
      const failures: string[] = []
      for (const source of sources) {
        try {
          const operationGuard = captureFileExplorerOperationGuard(
            activeWorktreeId,
            source.operationOwner
          )
          await copyFileIntoDir({
            context: fileExplorerGuardContext(operationGuard, activeWorktreeId, worktreePath),
            operationGuard,
            sourcePath: source.path,
            destDir
          })
        } catch (err) {
          failures.push(
            extractIpcErrorMessage(
              err,
              translate('fileExplorer.moveCopy.copyFailed', "Failed to copy '{{name}}'.", {
                name: basename(source.path)
              })
            )
          )
        }
      }
      // A refresh failure must not report a completed copy as failed.
      await refreshDir(destDir).catch(() => {})
      reportFailures('copy', failures, sources.length)
    },
    [activeWorktreeId, worktreePath, refreshDir]
  )

  const submitMoveCopy = useCallback(
    (destDir: string) => {
      const request = moveCopyRequest
      setPendingRequest(null)
      if (!request) {
        return
      }
      void (request.mode === 'move' ? runMove : runCopy)(request.sources, destDir)
    },
    [moveCopyRequest, runMove, runCopy]
  )

  return { moveCopyRequest, handleMoveTo, handleCopyTo, canCopyTo, closeMoveCopy, submitMoveCopy }
}
