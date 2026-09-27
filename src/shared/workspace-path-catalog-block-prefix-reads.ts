import type { WorkspacePathCatalog } from './workspace-path-catalog'
import { workspacePathCatalogBlockChecksum } from './workspace-path-catalog-block-checksum'
import { decodeWorkspacePathCatalogBlockPayloads } from './workspace-path-catalog-block-decoding'
import {
  WORKSPACE_PATH_CATALOG_DECODE_CACHE_BYTES,
  type DecodedWorkspacePathCatalogBlock
} from './workspace-path-catalog-block-format'

type CatalogDecodeCache = Map<number, DecodedWorkspacePathCatalogBlock>

/** Bounded active-decoding window per catalog, not a whole-catalog cache. */
const decodedPathBlocks = new WeakMap<WorkspacePathCatalog, CatalogDecodeCache>()
const decodedPathBlockCounters = new WeakMap<
  WorkspacePathCatalog,
  { hits: number; misses: number }
>()

export function getWorkspacePathCatalogBlockPath(
  catalog: Extract<WorkspacePathCatalog, { storageKind: 'prefix-compressed' }>,
  pathId: number,
  domain: 'original' | 'folded'
): string {
  const rank = catalog.naturalRanks[pathId]
  if (rank === undefined) {
    throw new RangeError(`Unknown workspace path ID ${pathId}`)
  }
  const blockIndex = findPathBlock(catalog.rankBlockOffsets, rank)
  const cache = getDecodedBlockCache(catalog)
  let block = cache.get(blockIndex)
  if (!block) {
    recordDecodedPathBlockMiss(catalog)
    block = decodeCatalogPathBlock(catalog, blockIndex)
    cache.set(blockIndex, block)
    evictDecodedPathBlocks(cache, blockIndex)
  } else {
    recordDecodedPathBlockHit(catalog)
    cache.delete(blockIndex)
    cache.set(blockIndex, block)
  }
  const blockStart = catalog.rankBlockOffsets[blockIndex] ?? 0
  const blockOffset = rank - blockStart
  const path = (domain === 'original' ? block.originals : block.folded)[blockOffset]
  if (path === undefined) {
    throw new RangeError(`Unknown workspace path ID ${pathId}`)
  }
  return path
}

export function workspacePathCatalogPrefixCacheCounters(catalog: WorkspacePathCatalog): {
  hits: number
  misses: number
} {
  const counters = decodedPathBlockCounters.get(catalog)
  return counters ? { ...counters } : { hits: 0, misses: 0 }
}

function decodeCatalogPathBlock(
  catalog: Extract<WorkspacePathCatalog, { storageKind: 'prefix-compressed' }>,
  blockIndex: number
): DecodedWorkspacePathCatalogBlock {
  const originalStart = catalog.originalBlockOffsets[blockIndex] ?? 0
  const originalEnd = catalog.originalBlockOffsets[blockIndex + 1] ?? originalStart
  const foldedStart = catalog.foldedBlockOffsets[blockIndex] ?? 0
  const foldedEnd = catalog.foldedBlockOffsets[blockIndex + 1] ?? foldedStart
  const rankStart = catalog.rankBlockOffsets[blockIndex] ?? 0
  const rankEnd = catalog.rankBlockOffsets[blockIndex + 1] ?? rankStart
  if (
    catalog.blockFormatVersion !== 1 ||
    workspacePathCatalogBlockChecksum(
      catalog.originalBlockData.subarray(originalStart, originalEnd)
    ) !== catalog.originalBlockChecksums[blockIndex] ||
    workspacePathCatalogBlockChecksum(catalog.foldedBlockData.subarray(foldedStart, foldedEnd)) !==
      catalog.foldedBlockChecksums[blockIndex]
  ) {
    throw new Error('Workspace path catalog block checksum mismatch')
  }
  const originalData = catalog.originalBlockData.subarray(originalStart, originalEnd)
  const foldedData = catalog.foldedBlockData.subarray(foldedStart, foldedEnd)
  const flags = new Uint8Array(rankEnd - rankStart)
  for (let offset = 0; offset < flags.length; offset += 1) {
    const pathId = catalog.naturalOrder[rankStart + offset]
    flags[offset] = pathId === undefined ? 0 : (catalog.flags[pathId] ?? 0)
  }
  return decodeWorkspacePathCatalogBlockPayloads({
    originalData,
    foldedData,
    flags,
    pathCount: rankEnd - rankStart,
    checksums: [
      catalog.originalBlockChecksums[blockIndex] ?? 0,
      catalog.foldedBlockChecksums[blockIndex] ?? 0,
      workspacePathCatalogBlockChecksum(flags)
    ],
    blockFormatVersion: catalog.blockFormatVersion
  })
}

function recordDecodedPathBlockHit(catalog: WorkspacePathCatalog): void {
  const counters = decodedPathBlockCounters.get(catalog) ?? {
    hits: 0,
    misses: 0
  }
  counters.hits += 1
  decodedPathBlockCounters.set(catalog, counters)
}

function recordDecodedPathBlockMiss(catalog: WorkspacePathCatalog): void {
  const counters = decodedPathBlockCounters.get(catalog) ?? {
    hits: 0,
    misses: 0
  }
  counters.misses += 1
  decodedPathBlockCounters.set(catalog, counters)
}

function getDecodedBlockCache(catalog: WorkspacePathCatalog): CatalogDecodeCache {
  let cache = decodedPathBlocks.get(catalog)
  if (!cache) {
    cache = new Map()
    decodedPathBlocks.set(catalog, cache)
  }
  return cache
}

function evictDecodedPathBlocks(cache: CatalogDecodeCache, newestBlock: number): void {
  let retainedBytes = 0
  for (const block of cache.values()) {
    retainedBytes += block.byteLength
  }
  while (retainedBytes > WORKSPACE_PATH_CATALOG_DECODE_CACHE_BYTES && cache.size > 1) {
    const oldestBlock = cache.keys().next().value
    if (oldestBlock === undefined || oldestBlock === newestBlock) {
      break
    }
    retainedBytes -= cache.get(oldestBlock)?.byteLength ?? 0
    cache.delete(oldestBlock)
  }
  if ((cache.get(newestBlock)?.byteLength ?? 0) > WORKSPACE_PATH_CATALOG_DECODE_CACHE_BYTES) {
    cache.delete(newestBlock)
  }
}

function findPathBlock(rankBlockOffsets: Uint32Array, rank: number): number {
  let low = 0
  let high = rankBlockOffsets.length - 2
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const start = rankBlockOffsets[middle] ?? 0
    const end = rankBlockOffsets[middle + 1] ?? start
    if (rank < start) {
      high = middle - 1
    } else if (rank >= end) {
      low = middle + 1
    } else {
      return middle
    }
  }
  throw new RangeError(`Unknown workspace path rank ${rank}`)
}
