import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rename, rm, stat, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  workspacePathCatalogRetainedBytes,
  type WorkspacePathCatalog
} from '../../shared/workspace-path-catalog'
import {
  WORKSPACE_PATH_CATALOG_BLOCK_CODE_UNIT_LIMIT,
  WORKSPACE_PATH_CATALOG_BLOCK_PATH_LIMIT
} from '../../shared/workspace-path-catalog-blocks'
import { compareFileNames } from '../../shared/file-name-sort'
import {
  SPILL_BLOCK_FORMAT_VERSION,
  SPILL_DIRECTORY_ENTRY_BYTES,
  SPILL_HEADER_RESERVE_BYTES,
  SPILL_MAGIC,
  SPILL_MAX_BLOCK_BYTES,
  SPILL_MAX_DISK_BYTES,
  SPILL_SCHEMA_VERSION,
  type WorkspacePathSpillBuildOptions,
  type WorkspacePathSpillHeader,
  type WorkspacePathSpillRecord
} from './workspace-path-catalog-spill-format'
import {
  checkCancelled,
  hashIdentity,
  processIsAlive,
  writeAll,
  writeRecordBlock,
  writeZeroBytes
} from './workspace-path-catalog-spill-io'

export {
  SPILL_DIRECTORY_ENTRY_BYTES,
  SPILL_HEADER_RESERVE_BYTES,
  SPILL_MAX_BLOCK_BYTES,
  SPILL_SCHEMA_VERSION
}

export type { WorkspacePathSpillBuildOptions, WorkspacePathSpillHeader, WorkspacePathSpillRecord }

export { readWorkspacePathCatalogSpillHeader } from './workspace-path-catalog-spill-header'
export {
  openWorkspacePathCatalogSpillReader,
  removeWorkspacePathCatalogSpill
} from './workspace-path-catalog-spill-reader'

/** Writes sorted records as checksummed prefix blocks and atomically publishes one file. */
export async function cleanStaleWorkspacePathCatalogSpillDirectories(
  processDirectory: string
): Promise<void> {
  const rootDirectory = dirname(processDirectory)
  await mkdir(rootDirectory, { recursive: true, mode: 0o700 })
  const currentName = basename(processDirectory)
  for (const entry of await readdir(rootDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9]+$/.test(entry.name) || entry.name === currentName) {
      continue
    }
    const ownerPid = Number(entry.name)
    if (!Number.isSafeInteger(ownerPid) || processIsAlive(ownerPid)) {
      continue
    }
    await rm(join(rootDirectory, entry.name), { recursive: true, force: true })
  }
}

export async function prepareWorkspacePathCatalogSpillDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  for (const name of await readdir(directory)) {
    if (name.endsWith('.wpc') || name.endsWith('.run') || name.endsWith('.tmp')) {
      await rm(join(directory, name), { force: true })
    }
  }
}

export async function writeWorkspacePathCatalogSpill(
  args: WorkspacePathSpillBuildOptions
): Promise<{ catalog: WorkspacePathCatalog; fileBytes: number }> {
  if (!Number.isSafeInteger(args.pathCount) || args.pathCount < 0 || args.pathCount > 0xffff_ffff) {
    throw new RangeError('Workspace path spill count is outside the supported range')
  }
  const identityHash = hashIdentity(args.identityKey)
  await mkdir(args.directory, { recursive: true, mode: 0o700 })
  const tempPath = join(args.directory, `${identityHash}-${randomUUID()}.spill.tmp`)
  const finalPath = join(args.directory, `${identityHash}-${randomUUID()}.wpc`)
  const directoryOffset = SPILL_MAGIC.byteLength + 4 + SPILL_HEADER_RESERVE_BYTES
  const dataOffset = directoryOffset + args.pathCount * SPILL_DIRECTORY_ENTRY_BYTES
  const diskBudgetBytes = args.maxDiskBytes ?? SPILL_MAX_DISK_BYTES
  if (!Number.isSafeInteger(dataOffset) || dataOffset > diskBudgetBytes) {
    throw new RangeError('Workspace path spill directory exceeds safe bounds')
  }
  let fileHandle: FileHandle | null = null
  let pathCount = 0
  let blockCount = 0
  let logicalOriginalOffset = 0
  let logicalFoldedOffset = 0
  let dataBytes = 0
  let previousPath: string | null = null
  let recordsInBlock: WorkspacePathSpillRecord[] = []
  let codeUnitsInBlock = 0
  const originalOffsets = new Uint32Array(args.pathCount + 1)
  const foldedOffsets = new Uint32Array(args.pathCount + 1)
  const naturalOrder = new Uint32Array(args.pathCount)
  const flags = new Uint8Array(args.pathCount)
  const headerPrefix = Buffer.alloc(SPILL_MAGIC.byteLength + 4 + SPILL_HEADER_RESERVE_BYTES)
  SPILL_MAGIC.copy(headerPrefix, 0)
  try {
    fileHandle = await open(tempPath, 'wx', 0o600)
    await writeAll(fileHandle, headerPrefix, null)
    await writeZeroBytes(fileHandle, args.pathCount * SPILL_DIRECTORY_ENTRY_BYTES)
    for await (const record of args.records) {
      checkCancelled(args.cancellation)
      if (pathCount >= args.pathCount) {
        throw new Error('Workspace path spill received more records than declared')
      }
      if (previousPath !== null && compareFileNames(previousPath, record.relativePath) >= 0) {
        throw new Error('Workspace path spill records are not strictly naturally ordered')
      }
      const nextCodeUnits =
        record.relativePath.length +
        record.relativePath.toLocaleLowerCase(args.metadata.foldLocale).length
      if (nextCodeUnits > WORKSPACE_PATH_CATALOG_BLOCK_CODE_UNIT_LIMIT) {
        throw new Error('A workspace path exceeds the spill decoded-block limit')
      }
      if (
        recordsInBlock.length > 0 &&
        (recordsInBlock.length >= WORKSPACE_PATH_CATALOG_BLOCK_PATH_LIMIT ||
          codeUnitsInBlock + nextCodeUnits > WORKSPACE_PATH_CATALOG_BLOCK_CODE_UNIT_LIMIT)
      ) {
        const written = await writeRecordBlock(fileHandle, recordsInBlock, {
          directoryOffset,
          blockIndex: blockCount,
          cancellation: args.cancellation,
          foldLocale: args.metadata.foldLocale
        })
        blockCount += 1
        dataBytes += written.fileBytes
        if (dataOffset + dataBytes > diskBudgetBytes) {
          throw new Error('Workspace path spill exceeded its disk budget')
        }
        recordsInBlock = []
        codeUnitsInBlock = 0
      }
      recordsInBlock.push(record)
      codeUnitsInBlock += nextCodeUnits
      const encodedOriginalLength = new TextEncoder().encode(record.relativePath).byteLength
      const foldedLength = record.relativePath.toLocaleLowerCase(args.metadata.foldLocale).length
      originalOffsets[pathCount] = logicalOriginalOffset
      foldedOffsets[pathCount] = logicalFoldedOffset
      logicalOriginalOffset += encodedOriginalLength
      logicalFoldedOffset += foldedLength
      flags[pathCount] = record.flags
      naturalOrder[pathCount] = pathCount
      pathCount += 1
      previousPath = record.relativePath
      if (encodedOriginalLength > SPILL_MAX_BLOCK_BYTES) {
        throw new Error('A workspace path exceeds the spill block limit')
      }
      if (dataOffset + dataBytes > diskBudgetBytes) {
        throw new Error('Workspace path spill exceeded its disk budget')
      }
    }
    if (recordsInBlock.length > 0) {
      const written = await writeRecordBlock(fileHandle, recordsInBlock, {
        directoryOffset,
        blockIndex: blockCount,
        cancellation: args.cancellation,
        foldLocale: args.metadata.foldLocale
      })
      blockCount += 1
      dataBytes += written.fileBytes
      if (dataOffset + dataBytes > diskBudgetBytes) {
        throw new Error('Workspace path spill exceeded its disk budget')
      }
    }
    if (pathCount !== args.pathCount) {
      throw new Error('Workspace path spill record count did not match its declaration')
    }
    originalOffsets[pathCount] = logicalOriginalOffset
    foldedOffsets[pathCount] = logicalFoldedOffset
    const header: WorkspacePathSpillHeader = {
      schema: 'workspace-path-catalog-spill',
      schemaVersion: SPILL_SCHEMA_VERSION,
      blockFormatVersion: SPILL_BLOCK_FORMAT_VERSION,
      identityHash,
      generationId: args.generationId,
      pathCount,
      blockCount,
      directoryCapacity: args.pathCount,
      foldVersion: args.metadata.foldVersion,
      foldLocale: args.metadata.foldLocale,
      scopeRuleVersion: args.metadata.scopeRuleVersion,
      metadata: args.metadata
    }
    const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8')
    if (encodedHeader.byteLength > SPILL_HEADER_RESERVE_BYTES) {
      throw new Error('Workspace path spill header exceeded its fixed bound')
    }
    const headerLength = Buffer.alloc(4)
    headerLength.writeUInt32LE(encodedHeader.byteLength)
    await writeAll(fileHandle, headerLength, SPILL_MAGIC.byteLength)
    await writeAll(fileHandle, encodedHeader, SPILL_MAGIC.byteLength + 4)
    await fileHandle.sync()
    await fileHandle.close()
    fileHandle = null
    await rename(tempPath, finalPath)
    const fileBytes = (await stat(finalPath)).size
    const retainedBytes = workspacePathCatalogRetainedBytes(
      0,
      foldedOffsets,
      naturalOrder,
      flags,
      originalOffsets,
      { kind: 'disk-spilled' }
    )
    const catalog: WorkspacePathCatalog = {
      generationId: args.generationId,
      metadata: args.metadata,
      pathCount,
      originalOffsets,
      foldedOffsets,
      naturalOrder,
      flags,
      retainedBytes,
      storageKind: 'disk-spilled',
      spillFilePath: finalPath,
      spillIdentityKey: identityHash,
      spillHeaderBytes: SPILL_HEADER_RESERVE_BYTES,
      spillDirectoryOffset: directoryOffset,
      spillDirectoryCapacity: args.pathCount,
      spillDataOffset: dataOffset,
      spillBlockCount: blockCount
    }
    return { catalog, fileBytes }
  } catch (error) {
    await fileHandle?.close().catch(() => undefined)
    await rm(tempPath, { force: true }).catch(() => undefined)
    await rm(finalPath, { force: true }).catch(() => undefined)
    throw error
  }
}
