import type { Dispatch, SetStateAction } from 'react'
import type { FsChangedPayload } from '../../../../shared/filesystem-entry-types'
import type { DirCache, TreeNode } from './file-explorer-types'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../../shared/cross-platform-path'
import {
  purgeDirCacheSubtrees,
  purgeExpandedDirsSubtrees,
  clearStalePendingReveal
} from './file-explorer-watcher-reconcile'
import {
  canonicalizeFileExplorerWatchPath,
  createCachedDirPathIndex,
  normalizeExplorerAbsolutePath,
  parentDirForWatchPath,
  resolveCachedDirPath
} from './file-explorer-watch-path'

export type ProcessFileExplorerFsPayloadArgs = {
  payload: FsChangedPayload
  currentWorktreePath: string
  worktreeId: string
  cache: Record<string, DirCache>
  expanded: Set<string>
  followSymlinks?: boolean
  setDirCache: Dispatch<SetStateAction<Record<string, DirCache>>>
  setSelectedPath: Dispatch<SetStateAction<string | null>>
  refreshDir: (dirPath: string) => void
  refreshTree: () => void
}

function cachedDirectoryChild(
  cache: Record<string, DirCache>,
  cachedDirPath: string,
  childPath: string,
  childPathIndexes: Map<string, Map<string, TreeNode>>
): TreeNode | undefined {
  let childPaths = childPathIndexes.get(cachedDirPath)
  if (!childPaths) {
    childPaths = new Map(
      cache[cachedDirPath]?.children.map((child) => [
        normalizeRuntimePathForComparison(child.path),
        child
      ]) ?? []
    )
    childPathIndexes.set(cachedDirPath, childPaths)
  }
  return childPaths.get(normalizeRuntimePathForComparison(childPath))
}

function hasCachedDirectoryLink(
  cache: Record<string, DirCache>,
  cacheKeys: readonly string[]
): boolean {
  // Why: consumes the payload's shared key enumeration instead of forcing the casing-fallback index.
  const cachedPaths = new Set(cacheKeys.map(normalizeRuntimePathForComparison))
  for (const dirPath of cacheKeys) {
    for (const child of cache[dirPath].children) {
      if (child.isSymlink && cachedPaths.has(normalizeRuntimePathForComparison(child.path))) {
        return true
      }
    }
  }
  return false
}

export function processFileExplorerFsPayload(args: ProcessFileExplorerFsPayloadArgs): void {
  const {
    payload,
    currentWorktreePath,
    worktreeId,
    cache,
    setDirCache,
    setSelectedPath,
    refreshDir,
    refreshTree
  } = args
  if (
    normalizeRuntimePathForComparison(payload.worktreePath) !==
    normalizeRuntimePathForComparison(currentWorktreePath)
  ) {
    return
  }

  const dirsToRefresh = new Set<string>()
  const childPathIndexes = new Map<string, Map<string, TreeNode>>()
  let hasLinkedCache: boolean | undefined
  // Why: one cache enumeration serves the linked-alias check, casing-fallback lookups and the
  // subtree purge, so a payload never walks the cache twice.
  let enumeratedCacheKeys: string[] | undefined
  const cacheKeys = (): string[] => (enumeratedCacheKeys ??= Object.keys(cache))
  let cachedDirPathIndex: ReadonlyMap<string, string> | undefined
  const cachePathIndex = (): ReadonlyMap<string, string> =>
    (cachedDirPathIndex ??= createCachedDirPathIndex(cache, cacheKeys()))
  const cachedDirsToPurge = new Set<string>()
  const reconciledRenameSources = new Set<string>()
  let needsFullRefresh = false

  const queueCachedDirPurge = (cachedDir: string | null): void => {
    if (cachedDir) {
      cachedDirsToPurge.add(cachedDir)
    }
  }

  for (const evt of payload.events) {
    if (evt.kind === 'overflow') {
      needsFullRefresh = true
      break
    }

    const normalizedPath = canonicalizeFileExplorerWatchPath(currentWorktreePath, evt.absolutePath)
    if (!normalizedPath) {
      continue
    }

    const parent = parentDirForWatchPath(normalizedPath)
    const cachedParent = resolveCachedDirPath(cache, parent, currentWorktreePath, cachePathIndex)
    const updatedChild =
      evt.kind === 'update' && cachedParent
        ? cachedDirectoryChild(cache, cachedParent, normalizedPath, childPathIndexes)
        : undefined
    const knownFileUpdate =
      evt.kind === 'update' &&
      evt.isDirectory !== true &&
      updatedChild !== undefined &&
      !updatedChild.isDirectory &&
      updatedChild.isSymlink === false
    if (!knownFileUpdate) {
      hasLinkedCache ??= hasCachedDirectoryLink(cache, cacheKeys())
      // Native events name the target, so cached aliases need the existing bounded refresh too.
      needsFullRefresh ||= hasLinkedCache
    }

    if (evt.kind === 'delete') {
      // Why: watcher can't report isDirectory for deletes; a dirCache key means it was an expanded dir (design §4.4).
      const cachedDir = resolveCachedDirPath(
        cache,
        normalizedPath,
        currentWorktreePath,
        cachePathIndex
      )
      const wasDirectory = cachedDir !== null

      if (wasDirectory && cachedDir) {
        queueCachedDirPurge(cachedDir)
      }

      clearStalePendingReveal(normalizedPath)

      setSelectedPath((prev) => {
        if (
          prev &&
          normalizeRuntimePathForComparison(prev) ===
            normalizeRuntimePathForComparison(normalizedPath)
        ) {
          return null
        }
        if (prev && wasDirectory && isPathInsideOrEqual(normalizedPath, prev)) {
          return null
        }
        return prev
      })

      if (cachedParent) {
        dirsToRefresh.add(cachedParent)
      }
    } else if (evt.kind === 'create' || evt.kind === 'rename') {
      // Why: create and rename both change a parent's listing. Rename was
      // previously deferred (#10264) so Explorer stayed stale until focus
      // remounted the tree. Case-insensitive cache lookup covers Windows
      // drive-letter / path casing drift between watcher and worktree path.
      if (cachedParent) {
        dirsToRefresh.add(cachedParent)
      }
      if (evt.kind === 'rename') {
        const oldPath = evt.oldAbsolutePath
          ? canonicalizeFileExplorerWatchPath(currentWorktreePath, evt.oldAbsolutePath)
          : null
        const cachedOldDir = oldPath
          ? resolveCachedDirPath(cache, oldPath, currentWorktreePath, cachePathIndex)
          : null
        if (oldPath) {
          const oldParent = parentDirForWatchPath(oldPath)
          const cachedOldParent = resolveCachedDirPath(
            cache,
            oldParent,
            currentWorktreePath,
            cachePathIndex
          )
          if (cachedOldParent) {
            dirsToRefresh.add(cachedOldParent)
          }

          const sourceKey = normalizeRuntimePathForComparison(oldPath)
          if (!reconciledRenameSources.has(sourceKey)) {
            reconciledRenameSources.add(sourceKey)
            clearStalePendingReveal(oldPath)
            setSelectedPath((prev) => {
              if (!prev) {
                return prev
              }
              const selectedSource = normalizeRuntimePathForComparison(prev)
              if (selectedSource === sourceKey) {
                return null
              }
              return cachedOldDir && isPathInsideOrEqual(oldPath, prev) ? null : prev
            })
          }
        }

        const cachedNewDir = resolveCachedDirPath(
          cache,
          normalizedPath,
          currentWorktreePath,
          cachePathIndex
        )
        queueCachedDirPurge(cachedOldDir)
        queueCachedDirPurge(cachedNewDir)
      }
    } else if (evt.kind === 'update') {
      const cachedDir = resolveCachedDirPath(
        cache,
        normalizedPath,
        currentWorktreePath,
        cachePathIndex
      )
      if (evt.isDirectory === true && cachedDir) {
        dirsToRefresh.add(cachedDir)
        continue
      }

      // Windows can classify a new file as update; existing file updates do not invalidate the tree.
      if (
        cachedParent &&
        !dirsToRefresh.has(cachedParent) &&
        !cachedDirectoryChild(cache, cachedParent, normalizedPath, childPathIndexes)
      ) {
        dirsToRefresh.add(cachedParent)
      }
    }
  }

  if (cachedDirsToPurge.size > 0) {
    purgeDirCacheSubtrees(setDirCache, cachedDirsToPurge, { snapshot: cache, keys: cacheKeys() })
  }
  purgeExpandedDirsSubtrees(worktreeId, cachedDirsToPurge)

  if (needsFullRefresh) {
    refreshTree()
    return
  }

  const rootPath = normalizeExplorerAbsolutePath(currentWorktreePath)
  for (const dirPath of dirsToRefresh) {
    const isRoot =
      normalizeRuntimePathForComparison(dirPath) === normalizeRuntimePathForComparison(rootPath)
    if (isRoot || dirPath in cache) {
      refreshDir(dirPath)
    }
  }
}
