// Public entry point for the version-1 prefix block codec. Implementation is split by concern:
// format/bounds, varint primitives, encoding, decoding, and the bounded decoded-block read window.
// See docs/reference/workspace-path-catalog-block-format.md.
export {
  WORKSPACE_PATH_CATALOG_BLOCK_CODE_UNIT_LIMIT,
  WORKSPACE_PATH_CATALOG_BLOCK_PATH_LIMIT,
  WORKSPACE_PATH_CATALOG_DECODE_CACHE_BYTES
} from './workspace-path-catalog-block-format'
export type {
  DecodedWorkspacePathCatalogBlock,
  WorkspacePathCatalogPrefixBlocks
} from './workspace-path-catalog-block-format'
export { workspacePathCatalogBlockChecksum } from './workspace-path-catalog-block-checksum'
export {
  buildWorkspacePathCatalogPrefixBlocks,
  encodeWorkspacePathCatalogBlock
} from './workspace-path-catalog-block-encoding'
export { decodeWorkspacePathCatalogBlockPayloads } from './workspace-path-catalog-block-decoding'
export {
  getWorkspacePathCatalogBlockPath,
  workspacePathCatalogPrefixCacheCounters
} from './workspace-path-catalog-block-prefix-reads'
