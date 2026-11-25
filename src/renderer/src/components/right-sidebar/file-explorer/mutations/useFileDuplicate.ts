import { useCallback } from 'react'
import { toast } from 'sonner'
import { basename, dirname } from '@/lib/path'
import type { TreeNode } from '../tree/file-explorer-types'
import { copyFileIntoDir, fileExplorerGuardContext } from './file-explorer-copy-into-dir'
import { extractIpcErrorMessage } from './useFileExplorerMoveDrop'
import { captureFileExplorerOperationGuard } from '../navigation/file-explorer-operation-owner'
import { translate } from '@/i18n/i18n'

type UseFileDuplicateParams = {
  activeWorktreeId: string | null
  worktreePath: string | null
  refreshDir: (dirPath: string) => Promise<void>
}

export function useFileDuplicate({
  activeWorktreeId,
  worktreePath,
  refreshDir
}: UseFileDuplicateParams): (node: TreeNode) => void {
  return useCallback(
    (node: TreeNode) => {
      if (node.isDirectory || !worktreePath) {
        return
      }
      const dir = dirname(node.path)
      const name = basename(node.path)
      const failedMessage = (err: unknown): string =>
        extractIpcErrorMessage(
          err,
          translate(
            'components.toastFallbacks.fileDuplicateFailed',
            "Failed to duplicate '{{name}}'.",
            { name }
          )
        )

      const run = async (): Promise<void> => {
        try {
          const operationGuard = captureFileExplorerOperationGuard(
            activeWorktreeId,
            node.operationOwner
          )
          await copyFileIntoDir({
            context: fileExplorerGuardContext(operationGuard, activeWorktreeId, worktreePath),
            operationGuard,
            sourcePath: node.path,
            destDir: dir
          })
        } catch (err) {
          toast.error(failedMessage(err))
          return
        }

        // Refresh failures must not report an already-successful copy as failed.
        try {
          await refreshDir(dir)
        } catch {}
      }
      void run()
    },
    [activeWorktreeId, worktreePath, refreshDir]
  )
}
