import type { WorkspacePathCatalogBuildRecord } from './workspace-path-catalog-builder-collection'
import { workspacePathCatalogBlockChecksum } from './workspace-path-catalog-block-checksum'
import {
  WORKSPACE_PATH_CATALOG_BLOCK_CODE_UNIT_LIMIT,
  WORKSPACE_PATH_CATALOG_BLOCK_PATH_LIMIT,
  type EncodedPathBlocks,
  type WorkspacePathCatalogPrefixBlocks
} from './workspace-path-catalog-block-format'
import {
  commonPrefixLength,
  varintLength,
  writeVarint
} from './workspace-path-catalog-block-varint'

/** Prefixes reset at bounded natural-order block boundaries. */
export function buildWorkspacePathCatalogPrefixBlocks(
  records: readonly WorkspacePathCatalogBuildRecord[],
  naturalOrder: Uint32Array
): WorkspacePathCatalogPrefixBlocks {
  const rankBlockOffsets: number[] = [0]
  let blockStart = 0
  let blockCodeUnits = 0
  for (let rank = 0; rank < naturalOrder.length; rank += 1) {
    const pathId = naturalOrder[rank]
    const record = pathId === undefined ? undefined : records[pathId]
    const nextCodeUnits = (record?.relativePath.length ?? 0) + (record?.foldedPath.length ?? 0)
    if (
      rank > blockStart &&
      (rank - blockStart >= WORKSPACE_PATH_CATALOG_BLOCK_PATH_LIMIT ||
        blockCodeUnits + nextCodeUnits > WORKSPACE_PATH_CATALOG_BLOCK_CODE_UNIT_LIMIT)
    ) {
      rankBlockOffsets.push(rank)
      blockStart = rank
      blockCodeUnits = 0
    }
    blockCodeUnits += nextCodeUnits
  }
  rankBlockOffsets.push(naturalOrder.length)
  const rankOffsets = Uint32Array.from(rankBlockOffsets)
  const originalBlocks = encodeWorkspacePathBlocks(records, naturalOrder, rankOffsets, 'original')
  const foldedBlocks = encodeWorkspacePathBlocks(records, naturalOrder, rankOffsets, 'folded')
  const naturalRanks = new Uint32Array(naturalOrder.length)
  for (let rank = 0; rank < naturalOrder.length; rank += 1) {
    const pathId = naturalOrder[rank]
    if (pathId !== undefined) {
      naturalRanks[pathId] = rank
    }
  }
  return {
    blockFormatVersion: 1,
    originalBlockData: originalBlocks.data,
    originalBlockOffsets: originalBlocks.offsets,
    originalBlockChecksums: originalBlocks.checksums,
    foldedBlockData: foldedBlocks.data,
    foldedBlockOffsets: foldedBlocks.offsets,
    foldedBlockChecksums: foldedBlocks.checksums,
    rankBlockOffsets: rankOffsets,
    naturalRanks
  }
}

export function encodeWorkspacePathCatalogBlock(args: {
  originals: readonly string[]
  folded: readonly string[]
  flags: Uint8Array
}): {
  originalData: Uint8Array
  foldedData: Uint8Array
  flags: Uint8Array
  checksums: readonly [number, number, number]
} {
  if (args.originals.length !== args.folded.length || args.originals.length !== args.flags.length) {
    throw new RangeError('Workspace path catalog block columns have different lengths')
  }
  const encoder = new TextEncoder()
  const originalData = encodeStringBlock(args.originals, 'original', encoder)
  const foldedData = encodeStringBlock(args.folded, 'folded', encoder)
  const flags = Uint8Array.from(args.flags)
  return {
    originalData,
    foldedData,
    flags,
    checksums: [
      workspacePathCatalogBlockChecksum(originalData),
      workspacePathCatalogBlockChecksum(foldedData),
      workspacePathCatalogBlockChecksum(flags)
    ]
  }
}

function encodeWorkspacePathBlocks(
  records: readonly WorkspacePathCatalogBuildRecord[],
  naturalOrder: Uint32Array,
  rankBlockOffsets: Uint32Array,
  domain: 'original' | 'folded'
): EncodedPathBlocks {
  const blockCount = rankBlockOffsets.length - 1
  const encodedBlocks: Uint8Array[] = []
  const offsets = new Uint32Array(blockCount + 1)
  const checksums = new Uint32Array(blockCount)
  const encoder = new TextEncoder()
  let totalBytes = 0
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
    const rankStart = rankBlockOffsets[blockIndex] ?? 0
    const rankEnd = rankBlockOffsets[blockIndex + 1] ?? rankStart
    const strings: string[] = []
    for (let rank = rankStart; rank < rankEnd; rank += 1) {
      const pathId = naturalOrder[rank]
      const record = pathId === undefined ? undefined : records[pathId]
      strings.push(
        domain === 'original' ? (record?.relativePath ?? '') : (record?.foldedPath ?? '')
      )
    }
    const block = encodeStringBlock(strings, domain, encoder)
    offsets[blockIndex] = totalBytes
    checksums[blockIndex] = workspacePathCatalogBlockChecksum(block)
    totalBytes += block.byteLength
    encodedBlocks.push(block)
  }
  offsets[blockCount] = totalBytes
  const data = new Uint8Array(totalBytes)
  let writeOffset = 0
  for (const block of encodedBlocks) {
    data.set(block, writeOffset)
    writeOffset += block.byteLength
  }
  return { data, offsets, checksums }
}

/** Original suffixes are UTF-8; folded suffixes are UTF-16LE (locale folding changes length). */
function encodeStringBlock(
  strings: readonly string[],
  domain: 'original' | 'folded',
  encoder: TextEncoder
): Uint8Array {
  let byteLength = 0
  let previous = ''
  for (const value of strings) {
    const prefix = commonPrefixLength(previous, value, domain === 'original')
    const suffix = value.slice(prefix)
    const suffixBytes =
      domain === 'original' ? encoder.encode(suffix).byteLength : suffix.length * 2
    byteLength += varintLength(prefix) + varintLength(suffixBytes) + suffixBytes
    previous = value
  }
  const data = new Uint8Array(byteLength)
  let offset = 0
  previous = ''
  for (const value of strings) {
    const prefix = commonPrefixLength(previous, value, domain === 'original')
    const suffix = value.slice(prefix)
    const suffixBytes =
      domain === 'original' ? encoder.encode(suffix).byteLength : suffix.length * 2
    offset = writeVarint(prefix, data, offset)
    offset = writeVarint(suffixBytes, data, offset)
    if (domain === 'original') {
      offset += encoder.encodeInto(suffix, data.subarray(offset)).written
    } else {
      for (let index = 0; index < suffix.length; index += 1) {
        const codeUnit = suffix.charCodeAt(index)
        data[offset] = codeUnit & 0xff
        data[offset + 1] = codeUnit >>> 8
        offset += 2
      }
    }
    previous = value
  }
  return data
}
