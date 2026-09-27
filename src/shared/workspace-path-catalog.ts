import type { WorkspacePathSearchPathSet } from './workspace-path-search-contract'
import type { WorkspacePathCatalogOverlay } from './workspace-path-catalog-overlay'
import { compareFileNames } from './file-name-sort'
import { shouldIncludeQuickOpenPath } from './quick-open-filter'
import type { WorkspacePathCatalogTrigramPostings } from './workspace-path-catalog-trigram'
import {
  getWorkspacePathCatalogBlockPath,
  WORKSPACE_PATH_CATALOG_DECODE_CACHE_BYTES,
  type WorkspacePathCatalogPrefixBlocks
} from './workspace-path-catalog-blocks'

export const WORKSPACE_PATH_CATALOG_SCOPE_RULE_VERSION = 'quick-open-scope-v1'
export const WORKSPACE_PATH_CATALOG_FOLD_VERSION = 'locale-lowercase-v1'

export function workspacePathCatalogFoldCacheKey(): string {
  return `${WORKSPACE_PATH_CATALOG_FOLD_VERSION}:${resolveWorkspacePathFoldLocale()}`
}

export const WORKSPACE_PATH_CATALOG_FLAGS = {
  included: 1,
  all: 2,
  dotfile: 4,
  ignoreClassificationKnown: 8,
  ignored: 16
} as const

export type WorkspacePathCatalogFlags = number

export type WorkspacePathCatalogMetadata = {
  foldLocale: string
  foldVersion: string
  scopeRuleVersion: string
  includedComplete: boolean
  allComplete: boolean
  classificationComplete: boolean
  coverageExcludePathSegments: readonly (readonly string[])[]
  freshness: string
}

type WorkspacePathCatalogBase = {
  generationId: string
  metadata: WorkspacePathCatalogMetadata
  pathCount: number
  originalOffsets: Uint32Array
  foldedOffsets: Uint32Array
  naturalOrder: Uint32Array
  flags: Uint8Array
  retainedBytes: number
}

export type WorkspacePathCatalog = WorkspacePathCatalogBase &
  (
    | { storageKind: 'folded-strings'; originalUtf8: Uint8Array; foldedPaths: readonly string[] }
    | { storageKind: 'packed-folded'; originalUtf8: Uint8Array; foldedCodeUnits: Uint16Array }
    | ({ storageKind: 'prefix-compressed' } & WorkspacePathCatalogPrefixBlocks)
    | {
        storageKind: 'disk-spilled'
        spillFilePath: string
        spillIdentityKey: string
        spillHeaderBytes: number
        spillDirectoryOffset: number
        spillDirectoryCapacity: number
        spillDataOffset: number
        spillBlockCount: number
      }
  ) & { trigramPostings?: WorkspacePathCatalogTrigramPostings }

export type WorkspacePathCatalogGeneration = {
  catalog: WorkspacePathCatalog
  overlay?: WorkspacePathCatalogOverlay
  /** A restored checkpoint generation: last-known rows, and queries bound their first page. */
  provisionalLastKnown?: boolean
}

export function resolveWorkspacePathFoldLocale(): string {
  return new Intl.DateTimeFormat().resolvedOptions().locale
}

export function normalizeWorkspaceRelativePath(path: string): string {
  let normalized = path.replace(/\\/g, '/')
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2)
  }
  return normalized
}

export function getWorkspacePathCatalogOriginalPath(
  catalog: WorkspacePathCatalog,
  pathId: number
): string {
  if (catalog.storageKind === 'prefix-compressed') {
    return getWorkspacePathCatalogBlockPath(catalog, pathId, 'original')
  }
  if (catalog.storageKind === 'disk-spilled') {
    throw new Error('Disk-spilled original paths require the worker block reader')
  }
  const start = catalog.originalOffsets[pathId]
  const end = catalog.originalOffsets[pathId + 1]
  if (start === undefined || end === undefined) {
    throw new RangeError(`Unknown workspace path ID ${pathId}`)
  }
  return new TextDecoder().decode(catalog.originalUtf8.subarray(start, end))
}

export function getWorkspacePathCatalogFoldedPath(
  catalog: WorkspacePathCatalog,
  pathId: number
): string {
  const start = catalog.foldedOffsets[pathId]
  const end = catalog.foldedOffsets[pathId + 1]
  if (start === undefined || end === undefined) {
    throw new RangeError(`Unknown workspace path ID ${pathId}`)
  }
  if (catalog.storageKind === 'folded-strings') {
    const foldedPath = catalog.foldedPaths[pathId]
    if (foldedPath === undefined) {
      throw new RangeError(`Unknown workspace path ID ${pathId}`)
    }
    return foldedPath
  }
  if (catalog.storageKind === 'prefix-compressed') {
    return getWorkspacePathCatalogBlockPath(catalog, pathId, 'folded')
  }
  if (catalog.storageKind === 'disk-spilled') {
    throw new Error('Disk-spilled folded paths require the worker block reader')
  }
  let foldedPath = ''
  const foldedCodeUnits = catalog.foldedCodeUnits
  for (let offset = start; offset < end; offset += 1) {
    foldedPath += String.fromCharCode(foldedCodeUnits[offset] ?? 0)
  }
  return foldedPath
}

export function workspacePathCatalogRetainedBytes(
  originalByteLength: number,
  foldedOffsets: Uint32Array,
  naturalOrder: Uint32Array,
  flags: Uint8Array,
  originalOffsets: Uint32Array,
  foldedStorage:
    | { kind: 'folded-strings'; paths: readonly string[] }
    | { kind: 'packed-folded'; codeUnits: Uint16Array }
    | { kind: 'disk-spilled' }
    | {
        kind: 'prefix-compressed'
        blockDataBytes: number
        naturalRanks: Uint32Array
        originalBlockOffsets: Uint32Array
        originalBlockChecksums: Uint32Array
        foldedBlockOffsets: Uint32Array
        foldedBlockChecksums: Uint32Array
        rankBlockOffsets: Uint32Array
      }
): number {
  const numericBytes =
    originalByteLength +
    foldedOffsets.byteLength +
    naturalOrder.byteLength +
    flags.byteLength +
    originalOffsets.byteLength +
    256
  if (foldedStorage.kind === 'packed-folded') {
    return numericBytes + foldedStorage.codeUnits.byteLength
  }
  if (foldedStorage.kind === 'disk-spilled') {
    return numericBytes + WORKSPACE_PATH_CATALOG_DECODE_CACHE_BYTES
  }
  if (foldedStorage.kind === 'prefix-compressed') {
    return (
      numericBytes +
      foldedStorage.blockDataBytes +
      foldedStorage.naturalRanks.byteLength +
      foldedStorage.originalBlockOffsets.byteLength +
      foldedStorage.originalBlockChecksums.byteLength +
      foldedStorage.foldedBlockOffsets.byteLength +
      foldedStorage.foldedBlockChecksums.byteLength +
      foldedStorage.rankBlockOffsets.byteLength +
      WORKSPACE_PATH_CATALOG_DECODE_CACHE_BYTES
    )
  }
  let foldedStringBytes = 0
  for (const path of foldedStorage.paths) {
    foldedStringBytes += path.length * 2 + 48
  }
  return numericBytes + foldedStringBytes + foldedStorage.paths.length * 8
}

export function workspacePathCatalogPathFlags(
  path: string,
  pathSet: WorkspacePathSearchPathSet
): number {
  let flags =
    pathSet === 'included'
      ? WORKSPACE_PATH_CATALOG_FLAGS.included | WORKSPACE_PATH_CATALOG_FLAGS.all
      : WORKSPACE_PATH_CATALOG_FLAGS.all
  if (pathSet === 'included') {
    flags |= WORKSPACE_PATH_CATALOG_FLAGS.ignoreClassificationKnown
  }
  if (hasDotfileAncestry(path)) {
    flags |= WORKSPACE_PATH_CATALOG_FLAGS.dotfile
  }
  return flags
}

export function hasDotfileAncestry(path: string): boolean {
  let segmentStart = 0
  for (let index = 0; index <= path.length; index += 1) {
    if (index !== path.length && path.charCodeAt(index) !== 47) {
      continue
    }
    const segmentLength = index - segmentStart
    if (
      segmentLength > 1 &&
      path.charCodeAt(segmentStart) === 46 &&
      !(segmentLength === 2 && path.charCodeAt(segmentStart + 1) === 46)
    ) {
      return true
    }
    segmentStart = index + 1
  }
  return false
}

export function isEligibleWorkspaceCatalogPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.startsWith('../') &&
    shouldIncludeQuickOpenPath(path)
  )
}

export function compareWorkspaceCatalogPaths(a: string, b: string): number {
  return compareFileNames(a, b)
}
