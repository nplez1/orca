import type { WorkspacePathSearchPathSet } from './workspace-path-search-contract'
import type {
  WorkspacePathCatalogBuildRecord,
  WorkspacePathCatalogStorage
} from './workspace-path-catalog-builder'
import { WORKSPACE_PATH_CATALOG_FLAGS } from './workspace-path-catalog'

export function addWorkspacePathCatalogBatch(
  paths: Iterable<string>,
  pathSet: WorkspacePathSearchPathSet,
  addPath: (path: string, pathSet: WorkspacePathSearchPathSet) => boolean
): boolean {
  for (const path of paths) {
    if (!addPath(path, pathSet)) {
      return false
    }
  }
  return true
}

export function estimateWorkspacePathCatalogPathReservation(
  path: string,
  storage: WorkspacePathCatalogStorage
): number {
  let ascii = true
  for (let index = 0; index < path.length; index += 1) {
    if (path.charCodeAt(index) > 127) {
      ascii = false
      break
    }
  }
  const multiplier = storage === 'packed-folded' ? (ascii ? 8 : 14) : ascii ? 6 : 10
  return path.length * multiplier + 224
}

export function classifyWorkspacePathCatalogRecords(
  records: WorkspacePathCatalogBuildRecord[],
  includedComplete: boolean,
  allComplete: boolean
): boolean {
  if (!includedComplete || !allComplete) {
    return false
  }
  for (const record of records) {
    record.flags |=
      (record.flags & WORKSPACE_PATH_CATALOG_FLAGS.included) !== 0
        ? WORKSPACE_PATH_CATALOG_FLAGS.ignoreClassificationKnown
        : WORKSPACE_PATH_CATALOG_FLAGS.ignoreClassificationKnown |
          WORKSPACE_PATH_CATALOG_FLAGS.ignored
  }
  return true
}

export function estimateWorkspacePathCatalogLookupBytes(
  records: readonly WorkspacePathCatalogBuildRecord[]
): number {
  let bytes = records.length * 40
  for (const record of records) {
    bytes += record.relativePath.length * 2 + 48
  }
  return bytes
}
