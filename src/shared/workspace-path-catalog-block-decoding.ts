import { workspacePathCatalogBlockChecksum } from './workspace-path-catalog-block-checksum'
import type { DecodedWorkspacePathCatalogBlock } from './workspace-path-catalog-block-format'
import { readVarint } from './workspace-path-catalog-block-varint'

export function decodeWorkspacePathCatalogBlockPayloads(args: {
  originalData: Uint8Array
  foldedData: Uint8Array
  flags: Uint8Array
  pathCount: number
  checksums: readonly [number, number, number]
  blockFormatVersion: number
}): DecodedWorkspacePathCatalogBlock {
  if (
    args.blockFormatVersion !== 1 ||
    workspacePathCatalogBlockChecksum(args.originalData) !== args.checksums[0] ||
    workspacePathCatalogBlockChecksum(args.foldedData) !== args.checksums[1] ||
    workspacePathCatalogBlockChecksum(args.flags) !== args.checksums[2]
  ) {
    throw new Error('Workspace path catalog block checksum mismatch')
  }
  const originals = decodeStringBlock(args.originalData, args.pathCount, 'original')
  const folded = decodeStringBlock(args.foldedData, args.pathCount, 'folded')
  if (args.flags.length !== args.pathCount) {
    throw new Error('Workspace path catalog block flags are corrupt')
  }
  let byteLength = args.flags.byteLength
  for (let index = 0; index < originals.length; index += 1) {
    byteLength += (originals[index]?.length ?? 0) * 2 + (folded[index]?.length ?? 0) * 2 + 8
  }
  return {
    originals,
    folded,
    flags: args.flags,
    byteLength,
    encodedByteLength:
      args.originalData.byteLength + args.foldedData.byteLength + args.flags.byteLength
  }
}

function decodeStringBlock(
  bytes: Uint8Array,
  pathCount: number,
  domain: 'original' | 'folded'
): string[] {
  const paths: string[] = []
  const decoder = domain === 'original' ? new TextDecoder() : null
  let offset = 0
  let previous = ''
  while (paths.length < pathCount) {
    const prefix = readVarint(bytes, offset)
    offset = prefix.nextOffset
    const suffixLength = readVarint(bytes, offset)
    offset = suffixLength.nextOffset
    const suffixEnd = offset + suffixLength.value
    if (suffixEnd > bytes.length || prefix.value > previous.length) {
      throw new Error('Workspace path catalog block is corrupt')
    }
    let suffix = ''
    if (domain === 'original') {
      suffix = decoder?.decode(bytes.subarray(offset, suffixEnd)) ?? ''
    } else {
      if (suffixLength.value % 2 !== 0) {
        throw new Error('Workspace path catalog folded block is corrupt')
      }
      for (let codeOffset = offset; codeOffset < suffixEnd; codeOffset += 2) {
        suffix += String.fromCharCode(
          (bytes[codeOffset] ?? 0) | ((bytes[codeOffset + 1] ?? 0) << 8)
        )
      }
    }
    previous = previous.slice(0, prefix.value) + suffix
    paths.push(previous)
    offset = suffixEnd
  }
  if (offset !== bytes.length) {
    throw new Error('Workspace path catalog block has trailing data')
  }
  return paths
}
