import { open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { WORKSPACE_PATH_CATALOG_BLOCK_PATH_LIMIT } from '../../shared/workspace-path-catalog-blocks'
import { SPILL_DIRECTORY_ENTRY_BYTES, SPILL_MAX_BLOCK_BYTES } from './workspace-path-catalog-spill'

const DIRECTORY_ENTRIES_PER_READ = 4096

/**
 * Validates the whole block directory — counts, payload lengths, accumulated offsets, and the
 * path total — before a checkpoint is served. Per-block checksums stay lazy in the reader, so this
 * catches a truncated or forged directory up front while a damaged payload body still fails on read
 * as a corruption error rather than an empty result.
 */
export async function validateWorkspacePathCatalogCheckpointPayloadDirectory(args: {
  payloadPath: string
  directoryOffset: number
  dataOffset: number
  pathCount: number
  blockCount: number
}): Promise<boolean> {
  const fileHandle = await open(args.payloadPath, 'r')
  try {
    return await validateDirectory(fileHandle, args)
  } finally {
    await fileHandle.close()
  }
}

async function validateDirectory(
  fileHandle: FileHandle,
  args: {
    directoryOffset: number
    dataOffset: number
    pathCount: number
    blockCount: number
  }
): Promise<boolean> {
  const fileSize = (await fileHandle.stat()).size
  if (args.dataOffset > fileSize) {
    return false
  }
  const entryBytes = SPILL_DIRECTORY_ENTRY_BYTES
  const buffer = Buffer.allocUnsafe(DIRECTORY_ENTRIES_PER_READ * entryBytes)
  let ranksSeen = 0
  let dataPosition = args.dataOffset
  for (let start = 0; start < args.blockCount; start += DIRECTORY_ENTRIES_PER_READ) {
    const entries = Math.min(DIRECTORY_ENTRIES_PER_READ, args.blockCount - start)
    const byteLength = entries * entryBytes
    if (
      !(await readFully(fileHandle, buffer, byteLength, args.directoryOffset + start * entryBytes))
    ) {
      return false
    }
    for (let index = 0; index < entries; index += 1) {
      const position = index * entryBytes
      const count = buffer.readUInt32LE(position)
      const originalLength = buffer.readUInt32LE(position + 4)
      const foldedLength = buffer.readUInt32LE(position + 12)
      if (
        count === 0 ||
        count > WORKSPACE_PATH_CATALOG_BLOCK_PATH_LIMIT ||
        originalLength > SPILL_MAX_BLOCK_BYTES ||
        foldedLength > SPILL_MAX_BLOCK_BYTES ||
        ranksSeen + count > args.pathCount ||
        dataPosition + originalLength + foldedLength + count > fileSize
      ) {
        return false
      }
      ranksSeen += count
      dataPosition += originalLength + foldedLength + count
    }
  }
  return ranksSeen === args.pathCount
}

async function readFully(
  fileHandle: FileHandle,
  buffer: Buffer,
  byteLength: number,
  position: number
): Promise<boolean> {
  let offset = 0
  while (offset < byteLength) {
    const { bytesRead } = await fileHandle.read(
      buffer,
      offset,
      byteLength - offset,
      position + offset
    )
    if (bytesRead <= 0) {
      return false
    }
    offset += bytesRead
  }
  return true
}
