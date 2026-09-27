import { open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type {
  WorkspacePathCatalog,
  WorkspacePathCatalogMetadata
} from '../../shared/workspace-path-catalog'
import {
  SPILL_BLOCK_FORMAT_VERSION,
  SPILL_HEADER_RESERVE_BYTES,
  SPILL_MAGIC,
  SPILL_SCHEMA_VERSION,
  type WorkspacePathSpillHeader
} from './workspace-path-catalog-spill-format'
import { readExactly } from './workspace-path-catalog-spill-io'

/** Reads and shape-validates a spill header without a catalog, to plan a checkpoint restore. */
export async function readWorkspacePathCatalogSpillHeader(
  filePath: string
): Promise<WorkspacePathSpillHeader> {
  const fileHandle = await open(filePath, 'r')
  try {
    return await readSpillHeaderValue(fileHandle)
  } finally {
    await fileHandle.close()
  }
}

export async function readWorkspacePathSpillHeader(
  fileHandle: FileHandle,
  catalog: Extract<WorkspacePathCatalog, { storageKind: 'disk-spilled' }>
): Promise<WorkspacePathSpillHeader> {
  const header = await readSpillHeaderValue(fileHandle)
  if (
    header.identityHash !== catalog.spillIdentityKey ||
    header.generationId !== catalog.generationId ||
    header.foldVersion !== catalog.metadata.foldVersion ||
    header.foldLocale !== catalog.metadata.foldLocale ||
    header.scopeRuleVersion !== catalog.metadata.scopeRuleVersion
  ) {
    throw new Error('Workspace path spill identity or policy does not match')
  }
  return header
}

async function readSpillHeaderValue(fileHandle: FileHandle): Promise<WorkspacePathSpillHeader> {
  const prefix = Buffer.alloc(SPILL_MAGIC.byteLength + 4)
  await readExactly(fileHandle, prefix, 0)
  if (!prefix.subarray(0, SPILL_MAGIC.byteLength).equals(SPILL_MAGIC)) {
    throw new Error('Workspace path spill magic is invalid')
  }
  const headerLength = prefix.readUInt32LE(SPILL_MAGIC.byteLength)
  if (headerLength === 0 || headerLength > SPILL_HEADER_RESERVE_BYTES) {
    throw new Error('Workspace path spill header length is invalid')
  }
  const headerBytes = Buffer.allocUnsafe(headerLength)
  await readExactly(fileHandle, headerBytes, SPILL_MAGIC.byteLength + 4)
  const value: unknown = JSON.parse(headerBytes.toString('utf8'))
  return validateSpillHeader(value)
}

function validateSpillHeader(value: unknown): WorkspacePathSpillHeader {
  if (!isWorkspacePathSpillHeader(value)) {
    throw new Error('Workspace path spill header fields are invalid')
  }
  return value
}

function isWorkspacePathSpillHeader(value: unknown): value is WorkspacePathSpillHeader {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return (
    'schema' in value &&
    value.schema === 'workspace-path-catalog-spill' &&
    'schemaVersion' in value &&
    value.schemaVersion === SPILL_SCHEMA_VERSION &&
    'blockFormatVersion' in value &&
    value.blockFormatVersion === SPILL_BLOCK_FORMAT_VERSION &&
    'identityHash' in value &&
    typeof value.identityHash === 'string' &&
    'generationId' in value &&
    typeof value.generationId === 'string' &&
    'pathCount' in value &&
    typeof value.pathCount === 'number' &&
    Number.isSafeInteger(value.pathCount) &&
    value.pathCount >= 0 &&
    'blockCount' in value &&
    typeof value.blockCount === 'number' &&
    Number.isSafeInteger(value.blockCount) &&
    value.blockCount >= 0 &&
    'directoryCapacity' in value &&
    typeof value.directoryCapacity === 'number' &&
    Number.isSafeInteger(value.directoryCapacity) &&
    'foldVersion' in value &&
    typeof value.foldVersion === 'string' &&
    'foldLocale' in value &&
    typeof value.foldLocale === 'string' &&
    'scopeRuleVersion' in value &&
    typeof value.scopeRuleVersion === 'string' &&
    'metadata' in value &&
    isWorkspacePathCatalogMetadata(value.metadata)
  )
}

function isWorkspacePathCatalogMetadata(value: unknown): value is WorkspacePathCatalogMetadata {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return (
    'foldLocale' in value &&
    typeof value.foldLocale === 'string' &&
    'foldVersion' in value &&
    typeof value.foldVersion === 'string' &&
    'scopeRuleVersion' in value &&
    typeof value.scopeRuleVersion === 'string' &&
    'includedComplete' in value &&
    typeof value.includedComplete === 'boolean' &&
    'allComplete' in value &&
    typeof value.allComplete === 'boolean' &&
    'classificationComplete' in value &&
    typeof value.classificationComplete === 'boolean' &&
    'coverageExcludePathSegments' in value &&
    Array.isArray(value.coverageExcludePathSegments) &&
    'freshness' in value &&
    typeof value.freshness === 'string'
  )
}
