import { open, type FileHandle } from 'node:fs/promises'
import {
  decodeWorkspacePathCatalogBlockPayloads,
  WORKSPACE_PATH_CATALOG_BLOCK_PATH_LIMIT
} from '../../shared/workspace-path-catalog-blocks'
import type { WorkspacePathSpillRecord } from './workspace-path-catalog-spill'
import {
  RUN_BLOCK_HEADER_BYTES,
  RUN_HEADER_BYTES,
  RUN_MAGIC,
  RUN_MAX_BLOCK_BYTES,
  RUN_VERSION,
  readRunBytes,
  type ActiveRunBlock
} from './workspace-path-catalog-spill-runs-file-writer'

export class RunCursor {
  current: WorkspacePathSpillRecord | null = null
  private readonly fileHandle: FileHandle
  private readonly pathCount: number
  private filePosition = RUN_HEADER_BYTES
  private recordsRead = 0
  private block: ActiveRunBlock | null = null

  private constructor(fileHandle: FileHandle, pathCount: number) {
    this.fileHandle = fileHandle
    this.pathCount = pathCount
  }

  static async open(path: string): Promise<RunCursor> {
    const fileHandle = await open(path, 'r')
    const header = Buffer.alloc(RUN_HEADER_BYTES)
    try {
      await readRunBytes(fileHandle, header, 0)
      if (
        !header.subarray(0, RUN_MAGIC.byteLength).equals(RUN_MAGIC) ||
        header.readUInt32LE(8) !== RUN_VERSION
      ) {
        throw new Error('Workspace path build run header is corrupt')
      }
      const pathCount = header.readUInt32LE(12)
      return new RunCursor(fileHandle, pathCount)
    } catch (error) {
      await fileHandle.close().catch(() => undefined)
      throw error
    }
  }

  async advance(): Promise<void> {
    if (this.block && this.block.index < this.block.records.length) {
      this.current = this.block.records[this.block.index] ?? null
      this.block.index += 1
      this.recordsRead += this.current ? 1 : 0
      return
    }
    if (this.recordsRead >= this.pathCount) {
      this.current = null
      return
    }
    const header = Buffer.alloc(RUN_BLOCK_HEADER_BYTES)
    await readRunBytes(this.fileHandle, header, this.filePosition)
    this.filePosition += RUN_BLOCK_HEADER_BYTES
    const count = header.readUInt32LE(0)
    const originalLength = header.readUInt32LE(4)
    const originalChecksum = header.readUInt32LE(8)
    const foldedLength = header.readUInt32LE(12)
    const foldedChecksum = header.readUInt32LE(16)
    const flagsChecksum = header.readUInt32LE(20)
    if (
      count === 0 ||
      count > WORKSPACE_PATH_CATALOG_BLOCK_PATH_LIMIT ||
      this.recordsRead + count > this.pathCount ||
      originalLength > RUN_MAX_BLOCK_BYTES ||
      foldedLength > RUN_MAX_BLOCK_BYTES
    ) {
      throw new Error('Workspace path build run block bounds are corrupt')
    }
    const originalData = Buffer.allocUnsafe(originalLength)
    const foldedData = Buffer.allocUnsafe(foldedLength)
    const flags = Buffer.allocUnsafe(count)
    await readRunBytes(this.fileHandle, originalData, this.filePosition)
    this.filePosition += originalLength
    await readRunBytes(this.fileHandle, foldedData, this.filePosition)
    this.filePosition += foldedLength
    await readRunBytes(this.fileHandle, flags, this.filePosition)
    this.filePosition += count
    const decoded = decodeWorkspacePathCatalogBlockPayloads({
      originalData,
      foldedData,
      flags,
      pathCount: count,
      checksums: [originalChecksum, foldedChecksum, flagsChecksum],
      blockFormatVersion: 1
    })
    const records = decoded.originals.map((relativePath, index) => ({
      relativePath,
      flags: decoded.flags[index] ?? 0
    }))
    this.block = { records, index: 0 }
    await this.advance()
  }

  close(): Promise<void> {
    return this.fileHandle.close()
  }
}
