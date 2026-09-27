/** Version-1 prefix block bounds, types, and the decoded-block window bound. */
export const WORKSPACE_PATH_CATALOG_BLOCK_PATH_LIMIT = 256
export const WORKSPACE_PATH_CATALOG_BLOCK_CODE_UNIT_LIMIT = 131_072
export const WORKSPACE_PATH_CATALOG_DECODE_CACHE_BYTES = 2 * 1024 * 1024

export type WorkspacePathCatalogPrefixBlocks = {
  blockFormatVersion: 1
  originalBlockData: Uint8Array
  originalBlockOffsets: Uint32Array
  originalBlockChecksums: Uint32Array
  foldedBlockData: Uint8Array
  foldedBlockOffsets: Uint32Array
  foldedBlockChecksums: Uint32Array
  rankBlockOffsets: Uint32Array
  naturalRanks: Uint32Array
}

export type EncodedPathBlocks = {
  data: Uint8Array
  offsets: Uint32Array
  checksums: Uint32Array
}

export type DecodedWorkspacePathCatalogBlock = {
  originals: string[]
  folded: string[]
  flags: Uint8Array
  byteLength: number
  encodedByteLength: number
}
