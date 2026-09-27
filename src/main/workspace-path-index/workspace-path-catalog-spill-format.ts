import type { WorkspacePathCatalogMetadata } from '../../shared/workspace-path-catalog'
import type { DecodedWorkspacePathCatalogBlock } from '../../shared/workspace-path-catalog-blocks'

export const SPILL_MAGIC = Buffer.from('ORCAPIDX')
export const SPILL_SCHEMA_VERSION = 1
export const SPILL_BLOCK_FORMAT_VERSION = 1
export const SPILL_HEADER_RESERVE_BYTES = 32 * 1024
export const SPILL_DIRECTORY_ENTRY_BYTES = 24
export const SPILL_MAX_BLOCK_BYTES = 512 * 1024
export const SPILL_MAX_DISK_BYTES = 4 * 1024 * 1024 * 1024
export const WRITE_CHUNK_BYTES = 64 * 1024

export type WorkspacePathSpillRecord = { relativePath: string; flags: number }

export type WorkspacePathSpillBuildOptions = {
  directory: string
  identityKey: string
  generationId: string
  metadata: WorkspacePathCatalogMetadata
  pathCount: number
  records: AsyncIterable<WorkspacePathSpillRecord>
  cancellation?: { isCancelled: () => boolean }
  maxDiskBytes?: number
}

export type WorkspacePathSpillHeader = {
  schema: 'workspace-path-catalog-spill'
  schemaVersion: number
  blockFormatVersion: number
  identityHash: string
  generationId: string
  pathCount: number
  blockCount: number
  directoryCapacity: number
  foldVersion: string
  foldLocale: string
  scopeRuleVersion: string
  metadata: WorkspacePathCatalogMetadata
}

export type WorkspacePathSpillReaderSession = {
  readBlock: (blockIndex: number) => Promise<DecodedWorkspacePathCatalogBlock>
  close: () => Promise<void>
}
