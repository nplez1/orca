import * as path from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { beginLocalWorkspacePathIndexReconciliation } from '../workspace-path-index/workspace-path-index-runtime'
import type { WatchedRoot } from './filesystem-watcher-wsl'
import { reconcileLocalWorkspacePathIndexEvents } from './filesystem-watcher-path-index-reconciliation'

const INDEX_EXCLUDED_SCOPE_PATHS = ['dist', 'build', 'target', '.venv', '__pycache__'] as const
const INDEX_EXCLUDED_SCOPE_VALIDATION_MS = 60_000

export function scheduleLocalWorkspacePathIndexCoverage(root: WatchedRoot): void {
  if (root.indexCoverageTimer) {
    clearTimeout(root.indexCoverageTimer)
  }
  if (root.indexConsumers.size === 0 || root.batch.cancelled) {
    root.indexCoverageTimer = null
    return
  }
  root.indexCoverageTimer = setTimeout(() => {
    root.indexCoverageTimer = null
    if (root.batch.cancelled || root.indexConsumers.size === 0) {
      return
    }
    const sequence = ++root.eventSequence
    beginLocalWorkspacePathIndexReconciliation(root.rootPath, INDEX_EXCLUDED_SCOPE_PATHS.length)
    const events = INDEX_EXCLUDED_SCOPE_PATHS.map((relativePath) => ({
      kind: 'create' as const,
      absolutePath: joinHostPath(root.rootPath, relativePath)
    }))
    root.indexReconciliationPromise = root.indexReconciliationPromise
      .then(() =>
        reconcileLocalWorkspacePathIndexEvents(
          root.rootPath,
          events,
          true,
          root.indexReconciliationController.signal,
          sequence
        )
      )
      .catch(() => undefined)
      .then(() => scheduleLocalWorkspacePathIndexCoverage(root))
  }, INDEX_EXCLUDED_SCOPE_VALIDATION_MS)
  root.indexCoverageTimer.unref?.()
}

function joinHostPath(rootPath: string, relativePath: string): string {
  const pathApi = isWindowsAbsolutePathLike(rootPath) ? path.win32 : path
  return pathApi.join(rootPath, relativePath)
}
