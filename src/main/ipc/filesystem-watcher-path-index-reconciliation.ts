import { lstat } from 'node:fs/promises'
import * as path from 'node:path'
import type { FsChangeEvent } from '../../shared/filesystem-entry-types'
import type { WorkspacePathIndexDeltaMutation } from '../workspace-path-index/workspace-path-index-worker-protocol'
import { workspacePathCatalogPathFlags } from '../../shared/workspace-path-catalog'
import { relativePathInsideRoot, isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { buildRgArgsForQuickOpen } from '../../shared/quick-open-filter'
import type { WorkspacePathSearchCorrelationId } from '../../shared/workspace-path-search-instrumentation'
import { getLocalGitOptionsForRegisteredWorktree } from './local-worktree-runtime-options'
import {
  applyLocalWorkspacePathIndexDelta,
  completeLocalWorkspacePathIndexReconciliation,
  failLocalWorkspacePathIndexReconciliation,
  hasLocalWorkspacePathIndex,
  hasLocalWorkspacePathIndexService,
  getLocalWorkspacePathIndexStore,
  invalidateLocalWorkspacePathIndex
} from '../workspace-path-index/workspace-path-index-runtime'
import { scanRipgrepPaths } from './quick-open-rg-path-scan'
import { parseWslPath } from '../wsl'

const DELTA_BATCH_PATHS = 256
let reconciliationSequence = 0

export async function reconcileLocalWorkspacePathIndexEvents(
  rootPath: string,
  events: readonly FsChangeEvent[],
  finishReconciliation: boolean,
  signal?: AbortSignal,
  eventSequence?: number
): Promise<void> {
  if (!hasLocalWorkspacePathIndexService() || !hasLocalWorkspacePathIndex(rootPath)) {
    return
  }
  const store = getLocalWorkspacePathIndexStore()
  if (!store) {
    failLocalWorkspacePathIndexReconciliation(rootPath, 'index-store-unavailable')
    return
  }
  if (events.some(isWorkspacePathIndexPolicyEvent)) {
    invalidateLocalWorkspacePathIndex(rootPath, 'ignore-policy-change', events.length)
    return
  }
  const paths = new Set<string>()
  for (const event of events) {
    if (event.kind === 'create' || event.kind === 'delete' || event.kind === 'rename') {
      paths.add(event.absolutePath)
      if (event.oldAbsolutePath) {
        paths.add(event.oldAbsolutePath)
      }
    }
  }
  const sequence = eventSequence ?? ++reconciliationSequence
  const correlationId = `watcher-reconcile-${sequence}`
  try {
    const gitOptions = getLocalGitOptionsForRegisteredWorktree(store, rootPath, rootPath)
    const wslDistroForOutput = parseWslPath(rootPath)?.distro ?? gitOptions.wslDistro
    for (const absolutePath of paths) {
      const relativePath = relativePathInsideRoot(rootPath, absolutePath)
      if (relativePath === null || relativePath.length === 0) {
        continue
      }
      await applyMutationBatch(
        rootPath,
        [{ type: 'delete-prefix', path: relativePath }],
        correlationId,
        false
      )
      const targetPath = joinHostPath(rootPath, relativePath)
      let info: Awaited<ReturnType<typeof lstat>>
      try {
        info = await lstat(targetPath)
      } catch (error) {
        if (isMissingPath(error)) {
          continue
        }
        throw error
      }
      if (info.isSymbolicLink()) {
        continue
      }
      const rgArgs = buildRgArgsForQuickOpen({
        searchRoot: relativePath,
        excludePathPrefixes: [],
        forceSlashSeparator: process.platform === 'win32'
      })
      await scanScope('included', rgArgs.primary)
      await scanScope('all', rgArgs.ignoredPass)

      async function scanScope(pathSet: 'included' | 'all', args: string[]): Promise<void> {
        let batch: WorkspacePathIndexDeltaMutation[] = []
        await scanRipgrepPaths({
          args,
          authorizedRootPath: rootPath,
          excludePathPrefixes: [],
          localGitOptions: gitOptions,
          wslDistroForOutput,
          signal,
          onPathBatch: async (discoveredPaths) => {
            batch = discoveredPaths.map((pathValue) =>
              pathSet === 'included'
                ? {
                    type: 'upsert',
                    path: pathValue,
                    flags: workspacePathCatalogPathFlags(pathValue, 'included')
                  }
                : { type: 'add', path: pathValue, pathSet: 'all' }
            )
            return applyMutationBatch(rootPath, batch, correlationId, false)
          },
          batchSize: DELTA_BATCH_PATHS
        })
      }
    }
    if (finishReconciliation) {
      completeLocalWorkspacePathIndexReconciliation(rootPath)
    }
  } catch {
    failLocalWorkspacePathIndexReconciliation(rootPath, 'targeted-reconciliation-failed')
  }
}

async function applyMutationBatch(
  rootPath: string,
  mutations: readonly WorkspacePathIndexDeltaMutation[],
  correlationId: WorkspacePathSearchCorrelationId,
  finishReconciliation: boolean
): Promise<boolean> {
  if (mutations.length === 0) {
    return true
  }
  return applyLocalWorkspacePathIndexDelta(rootPath, mutations, correlationId, finishReconciliation)
}

function joinHostPath(rootPath: string, relativePath: string): string {
  const pathApi = isWindowsAbsolutePathLike(rootPath) ? path.win32 : path
  return pathApi.join(rootPath, ...relativePath.split('/'))
}

export function isWorkspacePathIndexPolicyEvent(event: FsChangeEvent): boolean {
  return isWorkspacePathIndexPolicyPath(event.absolutePath)
}

export function isWorkspacePathIndexPolicyPath(absolutePath: string): boolean {
  const relativePath = absolutePath.replace(/\\/g, '/')
  const basename = relativePath.slice(relativePath.lastIndexOf('/') + 1).toLowerCase()
  return (
    basename === '.gitignore' ||
    basename === '.ignore' ||
    basename === '.rgignore' ||
    basename === '.gitconfig' ||
    basename === '.gitignore_global' ||
    (basename === 'config' &&
      (relativePath.toLowerCase().includes('/.git/') ||
        relativePath.toLowerCase().endsWith('/.config/git/config'))) ||
    relativePath.toLowerCase().endsWith('/.git/info/exclude') ||
    relativePath.toLowerCase().endsWith('/.config/git/ignore')
  )
}

export function needsWorkspacePathIndexReconciliation(event: FsChangeEvent): boolean {
  return (
    event.kind === 'create' ||
    event.kind === 'delete' ||
    event.kind === 'rename' ||
    isWorkspacePathIndexPolicyEvent(event)
  )
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}
