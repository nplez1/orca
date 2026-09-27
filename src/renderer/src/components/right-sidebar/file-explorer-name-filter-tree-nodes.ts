import { joinPath } from '@/lib/path'
import { getUtf8ByteLength } from '../../../../shared/utf8-byte-limits'
import type { FileExplorerOperationOwner, TreeNode } from './file-explorer-types'
import type { AcceptedNameFilterPath } from './file-explorer-name-filter-path-acceptance'

export type SyntheticTreeEntry = {
  node: TreeNode
  children: Map<string, SyntheticTreeEntry>
  relativePathUtf8Bytes: number
}

export type NameFilteredPathInsertionState = {
  relativePath: string
  entries: SyntheticTreeEntry[]
}

type NameFilteredPathInsertionFrame = {
  depthOffset: number
  suffixSegments: string[]
  entries: SyntheticTreeEntry[]
  currentChildren: Map<string, SyntheticTreeEntry>
  parentRelativePath: string
  parentRelativePathUtf8Bytes: number
}

export type SyntheticTreePathRoot = {
  pathPrefix: string
  separator: '/' | '\\'
  prefixUtf8Bytes: number
}

export function createProjectionAbortError(): Error {
  const error = new Error('Name-filter projection was superseded')
  error.name = 'AbortError'
  return error
}

function createSyntheticNode(
  pathRoot: SyntheticTreePathRoot,
  relativePath: string,
  name: string,
  depth: number,
  isDirectory: boolean,
  operationOwner: FileExplorerOperationOwner | undefined
): TreeNode {
  return {
    name,
    path:
      pathRoot.pathPrefix +
      (pathRoot.separator === '/' ? relativePath : relativePath.replace(/\//g, '\\')),
    relativePath,
    isDirectory,
    depth,
    operationOwner
  }
}

function estimateSyntheticNodeBytes(
  nameBytes: number,
  pathBytes: number,
  relativePathBytes: number
): number {
  return nameBytes + pathBytes + relativePathBytes + 64
}

export function createSyntheticTreePathRoot(worktreePath: string): SyntheticTreePathRoot {
  if (!worktreePath) {
    return { pathPrefix: '', separator: '/', prefixUtf8Bytes: 0 }
  }
  const separator = worktreePath.includes('\\') ? '\\' : '/'
  const pathPrefix = `${joinPath(worktreePath, '')}${separator}`
  return {
    pathPrefix,
    separator,
    prefixUtf8Bytes: getUtf8ByteLength(pathPrefix)
  }
}

function joinNameFilteredRelativePath(parentRelativePath: string, name: string): string {
  return parentRelativePath ? `${parentRelativePath}/${name}` : name
}

function insertNameFilteredSegment(args: {
  children: Map<string, SyntheticTreeEntry>
  name: string
  parentRelativePath: string
  parentRelativePathUtf8Bytes: number
  depth: number
  isDirectory: boolean
  pathRoot: SyntheticTreePathRoot
  operationOwner: FileExplorerOperationOwner | undefined
  onNodeCreated: (estimatedBytes: number) => void
}): SyntheticTreeEntry {
  let entry = args.children.get(args.name)
  if (!entry) {
    const relativePath = joinNameFilteredRelativePath(args.parentRelativePath, args.name)
    const node = createSyntheticNode(
      args.pathRoot,
      relativePath,
      args.name,
      args.depth,
      args.isDirectory,
      args.operationOwner
    )
    const nameBytes = getUtf8ByteLength(args.name)
    const relativePathUtf8Bytes =
      args.parentRelativePathUtf8Bytes + (args.parentRelativePath ? 1 : 0) + nameBytes
    const pathBytes = args.pathRoot.prefixUtf8Bytes + relativePathUtf8Bytes
    entry = { node, children: new Map(), relativePathUtf8Bytes }
    args.children.set(args.name, entry)
    args.onNodeCreated(estimateSyntheticNodeBytes(nameBytes, pathBytes, relativePathUtf8Bytes))
  } else if (args.isDirectory && !entry.node.isDirectory) {
    entry.node = { ...entry.node, isDirectory: true }
  }
  return entry
}

// Reuse only complete path segments so repeated ancestors and byte estimates stay coherent.
function beginNameFilteredPathInsertion(
  rootChildren: Map<string, SyntheticTreeEntry>,
  acceptedPath: AcceptedNameFilterPath,
  state: NameFilteredPathInsertionState
): NameFilteredPathInsertionFrame {
  const relativePath = acceptedPath.relativePath
  let sharedCharacterCount = 0
  while (
    sharedCharacterCount < relativePath.length &&
    sharedCharacterCount < state.relativePath.length &&
    relativePath.charCodeAt(sharedCharacterCount) ===
      state.relativePath.charCodeAt(sharedCharacterCount)
  ) {
    sharedCharacterCount += 1
  }
  while (sharedCharacterCount > 0) {
    const currentBoundary =
      sharedCharacterCount === relativePath.length ||
      relativePath.charCodeAt(sharedCharacterCount) === 47
    const previousBoundary =
      sharedCharacterCount === state.relativePath.length ||
      state.relativePath.charCodeAt(sharedCharacterCount) === 47
    if (currentBoundary && previousBoundary) {
      break
    }
    sharedCharacterCount -= 1
  }
  let depthOffset = 0
  for (let index = 0; index < sharedCharacterCount; index += 1) {
    if (relativePath.charCodeAt(index) === 47) {
      depthOffset += 1
    }
  }
  if (sharedCharacterCount > 0 && relativePath.charCodeAt(sharedCharacterCount - 1) !== 47) {
    depthOffset += 1
  }
  let suffixStart = sharedCharacterCount
  if (relativePath.charCodeAt(suffixStart) === 47) {
    suffixStart += 1
  }
  const suffixPath = relativePath.slice(suffixStart)
  const suffixSegments = suffixPath ? suffixPath.split('/') : []
  if (suffixSegments.at(-1) === '') {
    suffixSegments.pop()
  }
  const entries = state.entries
  const sharedEntry = depthOffset > 0 ? entries[depthOffset - 1] : undefined
  entries.length = depthOffset
  if (sharedEntry && suffixSegments.length > 0 && !sharedEntry.node.isDirectory) {
    sharedEntry.node = { ...sharedEntry.node, isDirectory: true }
  }
  return {
    depthOffset,
    suffixSegments,
    entries,
    currentChildren: sharedEntry?.children ?? rootChildren,
    parentRelativePath: sharedEntry?.node.relativePath ?? '',
    parentRelativePathUtf8Bytes: sharedEntry?.relativePathUtf8Bytes ?? 0
  }
}

export function insertNameFilteredPath(
  rootChildren: Map<string, SyntheticTreeEntry>,
  acceptedPath: AcceptedNameFilterPath,
  state: NameFilteredPathInsertionState,
  pathRoot: SyntheticTreePathRoot,
  operationOwner: FileExplorerOperationOwner | undefined,
  onNodeCreated: (estimatedBytes: number) => void
): void {
  const frame = beginNameFilteredPathInsertion(rootChildren, acceptedPath, state)
  const totalDepth = frame.depthOffset + frame.suffixSegments.length
  for (let offset = 0; offset < frame.suffixSegments.length; offset += 1) {
    const depth = frame.depthOffset + offset
    const entry = insertNameFilteredSegment({
      children: frame.currentChildren,
      name: frame.suffixSegments[offset],
      parentRelativePath: frame.parentRelativePath,
      parentRelativePathUtf8Bytes: frame.parentRelativePathUtf8Bytes,
      depth,
      isDirectory: depth < totalDepth - 1,
      pathRoot,
      operationOwner,
      onNodeCreated
    })
    frame.entries.push(entry)
    frame.currentChildren = entry.children
    frame.parentRelativePath = entry.node.relativePath
    frame.parentRelativePathUtf8Bytes = entry.relativePathUtf8Bytes
  }
  state.relativePath = acceptedPath.relativePath
}

export function insertNameFilteredPathInChunks(args: {
  rootChildren: Map<string, SyntheticTreeEntry>
  acceptedPath: AcceptedNameFilterPath
  state: NameFilteredPathInsertionState
  pathRoot: SyntheticTreePathRoot
  operationOwner: FileExplorerOperationOwner | undefined
  onNodeCreated: (estimatedBytes: number) => void
  yieldIfNeeded: () => Promise<void> | null
  signal: AbortSignal
}): Promise<void> | null {
  const frame = beginNameFilteredPathInsertion(args.rootChildren, args.acceptedPath, args.state)
  const totalDepth = frame.depthOffset + frame.suffixSegments.length
  const insertFrom = (startOffset: number): Promise<void> | null => {
    for (let offset = startOffset; offset < frame.suffixSegments.length; offset += 1) {
      if (args.signal.aborted) {
        throw createProjectionAbortError()
      }
      const depth = frame.depthOffset + offset
      const entry = insertNameFilteredSegment({
        children: frame.currentChildren,
        name: frame.suffixSegments[offset],
        parentRelativePath: frame.parentRelativePath,
        parentRelativePathUtf8Bytes: frame.parentRelativePathUtf8Bytes,
        depth,
        isDirectory: depth < totalDepth - 1,
        pathRoot: args.pathRoot,
        operationOwner: args.operationOwner,
        onNodeCreated: args.onNodeCreated
      })
      frame.entries.push(entry)
      frame.currentChildren = entry.children
      frame.parentRelativePath = entry.node.relativePath
      frame.parentRelativePathUtf8Bytes = entry.relativePathUtf8Bytes
      const pause = args.yieldIfNeeded()
      if (pause) {
        return pause.then(() => insertFrom(offset + 1) ?? Promise.resolve())
      }
    }
    args.state.relativePath = args.acceptedPath.relativePath
    return null
  }
  return insertFrom(0)
}

/** True when the synthetic tree for these paths is large enough to need the chunked builder. */
export function shouldBuildNameFilterProjectionInChunks(paths: readonly string[] | null): boolean {
  if (!paths || paths.length > 128) {
    return paths !== null
  }
  let totalCodeUnits = 0
  for (const path of paths) {
    totalCodeUnits += path.length
    if (path.length > 16_384 || totalCodeUnits > 32_768 || path.split(/[\\/]/).length > 128) {
      return true
    }
  }
  return false
}
