import type { FileExplorerNameFilterProjectionSource } from './file-explorer-name-filter-policy'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'

/** Objects whose identity distinguishes one projection result set from another. */
type FileExplorerNameFilterProjectionIdentity =
  | NonNullable<FileExplorerNameFilterProjectionSource['workspacePathSearch']>
  | NonNullable<FileExplorerNameFilterProjectionSource['relativePaths']>

const projectionCache = new Map<string, FileExplorerRowProjection>()
const projectionCacheBytesByKey = new Map<string, number>()
export const projectionEstimatedBytesByObject = new WeakMap<FileExplorerRowProjection, number>()
const projectionIdentityByObject = new WeakMap<FileExplorerNameFilterProjectionIdentity, number>()
let nextProjectionIdentity = 0
let cachedProjectionBytes = 0
const MAX_CACHED_FILTER_PROJECTIONS = 8
const MAX_CACHED_FILTER_PROJECTION_BYTES = 16 * 1024 * 1024
export const MAX_NAME_FILTER_PROJECTION_ESTIMATED_BYTES = 16 * 1024 * 1024

function getProjectionIdentity(value: FileExplorerNameFilterProjectionIdentity): number {
  const existing = projectionIdentityByObject.get(value)
  if (existing !== undefined) {
    return existing
  }
  nextProjectionIdentity += 1
  projectionIdentityByObject.set(value, nextProjectionIdentity)
  return nextProjectionIdentity
}

export function getFileExplorerNameFilterProjectionCacheKey(args: {
  collapsedPaths?: ReadonlySet<string>
  ignoredSet: Set<string>
  nameFilter: FileExplorerNameFilterProjectionSource
  showDotfiles: boolean
  showGitIgnoredFiles: boolean
  worktreePath: string
}): string {
  const resultIdentity = args.nameFilter.workspacePathSearch ?? args.nameFilter.relativePaths
  const identity = resultIdentity ? getProjectionIdentity(resultIdentity) : 0
  const policy = {
    owner: args.nameFilter.operationOwner,
    scope: args.nameFilter.scopeIdentity,
    root: args.worktreePath,
    query: args.nameFilter.workspacePathSearch ? '' : args.nameFilter.query,
    showDotfiles: args.showDotfiles,
    showGitIgnoredFiles: args.showGitIgnoredFiles,
    collapsed: [...(args.collapsedPaths ?? [])].sort(),
    ignored: args.nameFilter.workspacePathSearch ? [] : [...args.ignoredSet].sort()
  }
  return `${identity}:${JSON.stringify(policy)}`
}

export function cacheFilteredProjection(key: string, projection: FileExplorerRowProjection): void {
  const previousBytes = projectionCacheBytesByKey.get(key) ?? 0
  projectionCache.delete(key)
  projectionCacheBytesByKey.delete(key)
  cachedProjectionBytes -= previousBytes
  const projectionBytes = getFileExplorerNameFilterProjectionEstimatedBytes(projection)
  if (projectionBytes > MAX_CACHED_FILTER_PROJECTION_BYTES) {
    return
  }
  projectionCache.set(key, projection)
  projectionCacheBytesByKey.set(key, projectionBytes)
  cachedProjectionBytes += projectionBytes
  while (
    projectionCache.size > MAX_CACHED_FILTER_PROJECTIONS ||
    cachedProjectionBytes > MAX_CACHED_FILTER_PROJECTION_BYTES
  ) {
    const oldestKey = projectionCache.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    cachedProjectionBytes -= projectionCacheBytesByKey.get(oldestKey) ?? 0
    projectionCacheBytesByKey.delete(oldestKey)
    projectionCache.delete(oldestKey)
  }
}

export function getFileExplorerNameFilterProjectionEstimatedBytes(
  projection: FileExplorerRowProjection
): number {
  return projectionEstimatedBytesByObject.get(projection) ?? 0
}

export function getCachedFilteredProjection(key: string): FileExplorerRowProjection | undefined {
  return projectionCache.get(key)
}
