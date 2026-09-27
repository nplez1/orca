import { open, rm } from 'node:fs/promises'
import type { WorkspacePathCatalog } from '../../shared/workspace-path-catalog'
import {
  decodeWorkspacePathCatalogBlockPayloads,
  WORKSPACE_PATH_CATALOG_BLOCK_PATH_LIMIT,
  type DecodedWorkspacePathCatalogBlock
} from '../../shared/workspace-path-catalog-blocks'
import {
  SPILL_DIRECTORY_ENTRY_BYTES,
  SPILL_HEADER_RESERVE_BYTES,
  SPILL_MAGIC,
  SPILL_MAX_BLOCK_BYTES,
  type WorkspacePathSpillReaderSession
} from './workspace-path-catalog-spill-format'
import { readWorkspacePathSpillHeader } from './workspace-path-catalog-spill-header'
import { readExactly } from './workspace-path-catalog-spill-io'

export const activeSpillReaders = new Map<string, number>()
export const pendingSpillDeletes = new Set<string>()

export async function openWorkspacePathCatalogSpillReader(
  catalog: Extract<WorkspacePathCatalog, { storageKind: 'disk-spilled' }>
): Promise<WorkspacePathSpillReaderSession> {
  const fileHandle = await open(catalog.spillFilePath, 'r')
  activeSpillReaders.set(
    catalog.spillFilePath,
    (activeSpillReaders.get(catalog.spillFilePath) ?? 0) + 1
  )
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) {
      return
    }
    closed = true
    await fileHandle.close()
    const remainingReaders = Math.max(0, (activeSpillReaders.get(catalog.spillFilePath) ?? 1) - 1)
    if (remainingReaders === 0) {
      activeSpillReaders.delete(catalog.spillFilePath)
      if (pendingSpillDeletes.delete(catalog.spillFilePath)) {
        await rm(catalog.spillFilePath, { force: true })
      }
    } else {
      activeSpillReaders.set(catalog.spillFilePath, remainingReaders)
    }
  }
  try {
    const header = await readWorkspacePathSpillHeader(fileHandle, catalog)
    const fileSize = (await fileHandle.stat()).size
    if (
      catalog.spillDataOffset > fileSize ||
      header.blockCount !== catalog.spillBlockCount ||
      header.pathCount !== catalog.pathCount ||
      header.directoryCapacity !== catalog.spillDirectoryCapacity ||
      header.blockCount > header.directoryCapacity ||
      catalog.spillDirectoryOffset !== SPILL_MAGIC.byteLength + 4 + SPILL_HEADER_RESERVE_BYTES ||
      catalog.spillDataOffset !==
        catalog.spillDirectoryOffset + catalog.spillDirectoryCapacity * SPILL_DIRECTORY_ENTRY_BYTES
    ) {
      throw new Error('Workspace path spill header bounds are invalid')
    }
    let nextBlock = 0
    let dataPosition = catalog.spillDataOffset
    let ranksSeen = 0
    const readBlock = async (blockIndex: number): Promise<DecodedWorkspacePathCatalogBlock> => {
      if (blockIndex !== nextBlock) {
        throw new RangeError('Workspace path spill blocks must be read in natural order')
      }
      if (blockIndex >= header.blockCount) {
        throw new RangeError('Unknown workspace path spill block')
      }
      const directoryEntry = Buffer.alloc(SPILL_DIRECTORY_ENTRY_BYTES)
      await readExactly(
        fileHandle,
        directoryEntry,
        catalog.spillDirectoryOffset + blockIndex * SPILL_DIRECTORY_ENTRY_BYTES
      )
      const count = directoryEntry.readUInt32LE(0)
      const originalLength = directoryEntry.readUInt32LE(4)
      const originalChecksum = directoryEntry.readUInt32LE(8)
      const foldedLength = directoryEntry.readUInt32LE(12)
      const foldedChecksum = directoryEntry.readUInt32LE(16)
      const flagsChecksum = directoryEntry.readUInt32LE(20)
      if (
        count === 0 ||
        count > WORKSPACE_PATH_CATALOG_BLOCK_PATH_LIMIT ||
        originalLength > SPILL_MAX_BLOCK_BYTES ||
        foldedLength > SPILL_MAX_BLOCK_BYTES ||
        ranksSeen + count > catalog.pathCount ||
        dataPosition + originalLength + foldedLength + count > fileSize
      ) {
        throw new Error('Workspace path spill block directory is corrupt')
      }
      const originalData = Buffer.allocUnsafe(originalLength)
      const foldedData = Buffer.allocUnsafe(foldedLength)
      const flags = Buffer.allocUnsafe(count)
      await readExactly(fileHandle, originalData, dataPosition)
      dataPosition += originalLength
      await readExactly(fileHandle, foldedData, dataPosition)
      dataPosition += foldedLength
      await readExactly(fileHandle, flags, dataPosition)
      dataPosition += count
      const decoded = decodeWorkspacePathCatalogBlockPayloads({
        originalData,
        foldedData,
        flags,
        pathCount: count,
        checksums: [originalChecksum, foldedChecksum, flagsChecksum],
        blockFormatVersion: header.blockFormatVersion
      })
      ranksSeen += count
      nextBlock += 1
      if (nextBlock === header.blockCount && ranksSeen !== catalog.pathCount) {
        throw new Error('Workspace path spill ended before all paths were read')
      }
      return decoded
    }
    return {
      readBlock,
      close
    }
  } catch (error) {
    await close().catch(() => undefined)
    throw error
  }
}

export async function removeWorkspacePathCatalogSpill(
  catalog: WorkspacePathCatalog
): Promise<void> {
  if (catalog.storageKind !== 'disk-spilled') {
    return
  }
  const activeReaders = activeSpillReaders.get(catalog.spillFilePath) ?? 0
  if (activeReaders > 0) {
    pendingSpillDeletes.add(catalog.spillFilePath)
    return
  }
  await rm(catalog.spillFilePath, { force: true })
}
