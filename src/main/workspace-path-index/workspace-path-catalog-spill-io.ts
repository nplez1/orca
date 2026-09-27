import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { encodeWorkspacePathCatalogBlock } from '../../shared/workspace-path-catalog-blocks'
import {
  SPILL_DIRECTORY_ENTRY_BYTES,
  SPILL_MAX_BLOCK_BYTES,
  WRITE_CHUNK_BYTES,
  type WorkspacePathSpillRecord
} from './workspace-path-catalog-spill-format'

export async function writeRecordBlock(
  fileHandle: FileHandle,
  records: readonly WorkspacePathSpillRecord[],
  args: {
    directoryOffset: number
    blockIndex: number
    cancellation?: { isCancelled: () => boolean }
    foldLocale: string
  }
): Promise<{ fileBytes: number }> {
  checkCancelled(args.cancellation)
  const originals = records.map((record) => record.relativePath)
  const folded = originals.map((path) => path.toLocaleLowerCase(args.foldLocale))
  const flags = Uint8Array.from(records.map((record) => record.flags))
  const encoded = encodeWorkspacePathCatalogBlock({ originals, folded, flags })
  if (
    encoded.originalData.byteLength > SPILL_MAX_BLOCK_BYTES ||
    encoded.foldedData.byteLength > SPILL_MAX_BLOCK_BYTES
  ) {
    throw new Error('Workspace path spill block exceeds its byte limit')
  }
  await writeAll(fileHandle, encoded.originalData, null)
  await writeAll(fileHandle, encoded.foldedData, null)
  await writeAll(fileHandle, encoded.flags, null)
  const entry = Buffer.alloc(SPILL_DIRECTORY_ENTRY_BYTES)
  entry.writeUInt32LE(records.length, 0)
  entry.writeUInt32LE(encoded.originalData.byteLength, 4)
  entry.writeUInt32LE(encoded.checksums[0], 8)
  entry.writeUInt32LE(encoded.foldedData.byteLength, 12)
  entry.writeUInt32LE(encoded.checksums[1], 16)
  entry.writeUInt32LE(encoded.checksums[2], 20)
  await writeAll(
    fileHandle,
    entry,
    args.directoryOffset + args.blockIndex * SPILL_DIRECTORY_ENTRY_BYTES
  )
  return {
    fileBytes:
      encoded.originalData.byteLength + encoded.foldedData.byteLength + encoded.flags.byteLength
  }
}

export function hashIdentity(identityKey: string): string {
  return createHash('sha256').update(identityKey).digest('hex')
}

export function checkCancelled(cancellation?: { isCancelled: () => boolean }): void {
  if (cancellation?.isCancelled()) {
    throw new Error('Workspace path spill build was cancelled')
  }
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

export async function writeZeroBytes(fileHandle: FileHandle, byteLength: number): Promise<void> {
  const zeroes = Buffer.alloc(Math.min(WRITE_CHUNK_BYTES, byteLength))
  let remaining = byteLength
  while (remaining > 0) {
    const count = Math.min(remaining, zeroes.byteLength)
    await writeAll(fileHandle, zeroes.subarray(0, count), null)
    remaining -= count
  }
}

export async function writeAll(
  fileHandle: FileHandle,
  data: Uint8Array,
  position: number | null
): Promise<void> {
  let offset = 0
  while (offset < data.byteLength) {
    const result = await fileHandle.write(data, offset, data.byteLength - offset, position)
    if (result.bytesWritten <= 0) {
      throw new Error('Workspace path spill write made no progress')
    }
    offset += result.bytesWritten
    if (position !== null) {
      position += result.bytesWritten
    }
  }
}

export async function readExactly(
  fileHandle: FileHandle,
  target: Buffer,
  position: number
): Promise<void> {
  let offset = 0
  while (offset < target.byteLength) {
    const result = await fileHandle.read(
      target,
      offset,
      target.byteLength - offset,
      position + offset
    )
    if (result.bytesRead <= 0) {
      throw new Error('Workspace path spill is truncated')
    }
    offset += result.bytesRead
  }
}
