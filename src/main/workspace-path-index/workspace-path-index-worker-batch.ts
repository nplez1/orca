import type { WorkspacePathSearchPathSet } from '../../shared/workspace-path-search-contract'
import type { WorkspacePathCatalogOverlayBuilder } from '../../shared/workspace-path-catalog-overlay'

export function decodeWorkspacePathIndexBatch(
  bytes: ArrayBuffer,
  offsets: Uint32Array,
  count: number
): string[] {
  if (offsets.length !== count + 1 || count > 256) {
    throw new RangeError('Workspace path batch has invalid bounds')
  }
  const decoder = new TextDecoder()
  const packed = new Uint8Array(bytes)
  const paths: string[] = []
  for (let index = 0; index < count; index += 1) {
    const start = offsets[index]
    const end = offsets[index + 1]
    if (start === undefined || end === undefined || start > end || end > packed.length) {
      throw new RangeError('Workspace path batch offsets are invalid')
    }
    paths.push(decoder.decode(packed.subarray(start, end)))
  }
  return paths
}

export function addWorkspacePathIndexOverlayBatch(
  builder: WorkspacePathCatalogOverlayBuilder | null,
  paths: readonly string[],
  pathSet: WorkspacePathSearchPathSet
): boolean {
  if (!builder) {
    return false
  }
  for (const path of paths) {
    if (!builder.addPath(path, pathSet)) {
      return false
    }
  }
  return true
}
