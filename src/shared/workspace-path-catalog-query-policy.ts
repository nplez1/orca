import {
  WORKSPACE_PATH_SEARCH_LOCAL_EXPLORER_MAX_PAGE_PATHS,
  WORKSPACE_PATH_SEARCH_ROW_FLAGS,
  type WorkspacePathSearchRowClassificationFlags,
  type WorkspacePathSearchScopeDescriptor
} from './workspace-path-search-contract'
import {
  getWorkspacePathCatalogFoldedPath,
  WORKSPACE_PATH_CATALOG_FLAGS,
  WORKSPACE_PATH_CATALOG_SCOPE_RULE_VERSION,
  type WorkspacePathCatalog
} from './workspace-path-catalog'
import { shouldExcludeQuickOpenRelPath } from './quick-open-filter'

export function workspacePathSearchScopeFingerprint(
  scope: WorkspacePathSearchScopeDescriptor,
  scopeRuleVersion = WORKSPACE_PATH_CATALOG_SCOPE_RULE_VERSION
): string {
  const excludes = scope.excludePathSegments.map((segments) => segments.join('/')).sort()
  return JSON.stringify({
    pathSet: scope.pathSet,
    includeDotfiles: scope.includeDotfiles,
    includeIgnoredFiles: scope.includeIgnoredFiles,
    excludePathSegments: excludes,
    scopeRuleVersion
  })
}

export function pathIsInWorkspaceCatalogScope(
  path: string,
  flags: number,
  scope: WorkspacePathSearchScopeDescriptor,
  excludedPrefixes: readonly string[]
): boolean {
  const membershipFlag =
    scope.pathSet === 'included'
      ? WORKSPACE_PATH_CATALOG_FLAGS.included
      : WORKSPACE_PATH_CATALOG_FLAGS.all
  if ((flags & membershipFlag) === 0) {
    return false
  }
  if (!scope.includeDotfiles && (flags & WORKSPACE_PATH_CATALOG_FLAGS.dotfile) !== 0) {
    return false
  }
  if (!scope.includeIgnoredFiles) {
    if ((flags & WORKSPACE_PATH_CATALOG_FLAGS.ignoreClassificationKnown) === 0) {
      return false
    }
    if ((flags & WORKSPACE_PATH_CATALOG_FLAGS.ignored) !== 0) {
      return false
    }
  }
  return excludedPrefixes.length === 0 || !shouldExcludeQuickOpenRelPath(path, excludedPrefixes)
}

export function workspaceCatalogPackedPathMatchesTokens(
  catalog: WorkspacePathCatalog,
  pathId: number,
  tokens: readonly string[]
): boolean {
  if (catalog.storageKind === 'prefix-compressed') {
    const foldedPath = decodeWorkspaceCatalogFoldedPath(catalog, pathId)
    return tokens.every((token) => foldedPath.includes(token))
  }
  if (catalog.storageKind !== 'packed-folded') {
    return false
  }
  const pathStart = catalog.foldedOffsets[pathId]
  const pathEnd = catalog.foldedOffsets[pathId + 1]
  if (pathStart === undefined || pathEnd === undefined) {
    return false
  }
  const foldedCodeUnits = catalog.foldedCodeUnits
  for (const token of tokens) {
    if (token.length === 0 || token.length > pathEnd - pathStart) {
      return false
    }
    const firstCodeUnit = token.charCodeAt(0)
    let found = false
    for (let offset = pathStart; offset <= pathEnd - token.length; offset += 1) {
      if (foldedCodeUnits[offset] !== firstCodeUnit) {
        continue
      }
      let tokenOffset = 1
      while (
        tokenOffset < token.length &&
        foldedCodeUnits[offset + tokenOffset] === token.charCodeAt(tokenOffset)
      ) {
        tokenOffset += 1
      }
      if (tokenOffset === token.length) {
        found = true
        break
      }
    }
    if (!found) {
      return false
    }
  }
  return true
}

export function decodeWorkspaceCatalogFoldedPath(
  catalog: WorkspacePathCatalog,
  pathId: number
): string {
  if (catalog.storageKind === 'folded-strings') {
    return catalog.foldedPaths[pathId] ?? ''
  }
  if (catalog.storageKind === 'prefix-compressed') {
    return getWorkspacePathCatalogFoldedPath(catalog, pathId)
  }
  if (catalog.storageKind === 'disk-spilled') {
    throw new Error('Disk-spilled folded paths require the worker block reader')
  }
  const start = catalog.foldedOffsets[pathId] ?? 0
  const end = catalog.foldedOffsets[pathId + 1] ?? start
  let foldedPath = ''
  for (let index = start; index < end; index += 1) {
    foldedPath += String.fromCharCode(catalog.foldedCodeUnits[index] ?? 0)
  }
  return foldedPath
}

export function workspaceCatalogRowClassificationFlags(
  flags: number
): WorkspacePathSearchRowClassificationFlags {
  let result = 0
  if ((flags & WORKSPACE_PATH_CATALOG_FLAGS.ignored) !== 0) {
    result |= WORKSPACE_PATH_SEARCH_ROW_FLAGS.ignored
  }
  if ((flags & WORKSPACE_PATH_CATALOG_FLAGS.dotfile) !== 0) {
    result |= WORKSPACE_PATH_SEARCH_ROW_FLAGS.dotfile
  }
  if ((flags & WORKSPACE_PATH_CATALOG_FLAGS.ignoreClassificationKnown) !== 0) {
    result |= WORKSPACE_PATH_SEARCH_ROW_FLAGS.ignoreClassificationKnown
  }
  if (result === 7 || result === 6 || result === 5 || result === 4 || result === 2) {
    return result
  }
  return 0
}

export function boundedWorkspacePathPageCount(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) {
    return 0
  }
  return Math.min(WORKSPACE_PATH_SEARCH_LOCAL_EXPLORER_MAX_PAGE_PATHS, Math.floor(requested))
}

const EMPTY_PATHS_PAYLOAD_PREFIX = '{"paths":[],"totalCount":'

export function emptyWorkspacePathsPayloadBytes(totalCount: number): number {
  return EMPTY_PATHS_PAYLOAD_PREFIX.length + decimalDigitCount(totalCount) + 1
}

export function workspacePathCatalogJsonStringByteLength(value: string): number {
  let byteLength = 2
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit === 34 || codeUnit === 92) {
      byteLength += 2
    } else if (codeUnit < 32) {
      byteLength +=
        codeUnit === 8 || codeUnit === 9 || codeUnit === 10 || codeUnit === 12 || codeUnit === 13
          ? 2
          : 6
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        byteLength += 4
        index += 1
      } else {
        byteLength += 6
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      byteLength += 6
    } else if (codeUnit <= 0x7f) {
      byteLength += 1
    } else if (codeUnit <= 0x7ff) {
      byteLength += 2
    } else {
      byteLength += 3
    }
  }
  return byteLength
}

function decimalDigitCount(value: number): number {
  if (value < 10) {
    return 1
  }
  let digits = 1
  let remainder = Math.floor(value)
  while (remainder >= 10) {
    remainder = Math.floor(remainder / 10)
    digits += 1
  }
  return digits
}
