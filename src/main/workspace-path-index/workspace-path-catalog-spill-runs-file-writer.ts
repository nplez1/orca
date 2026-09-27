import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import {
  encodeWorkspacePathCatalogBlock,
  WORKSPACE_PATH_CATALOG_BLOCK_CODE_UNIT_LIMIT,
  WORKSPACE_PATH_CATALOG_BLOCK_PATH_LIMIT
} from '../../shared/workspace-path-catalog-blocks'
import { compareFileNames } from '../../shared/file-name-sort'
import type { WorkspacePathSpillRecord } from './workspace-path-catalog-spill'
import { isWithinDiskBudget } from './workspace-path-catalog-spill-runs-disk-budget'

export const RUN_MAGIC = Buffer.from('ORCARUN1')
export const RUN_VERSION = 1
export const RUN_HEADER_BYTES = 16
export const RUN_BLOCK_HEADER_BYTES = 24
export const RUN_MAX_BLOCK_BYTES = 512 * 1024

export type RunFile = { path: string; records: number; level: number }
export type ActiveRunBlock = { records: WorkspacePathSpillRecord[]; index: number }

export function checkSpillCancelled(cancellation?: { isCancelled: () => boolean }): void {
  if (cancellation?.isCancelled()) {
    throw new Error('Workspace path catalog spill run was cancelled')
  }
}

export async function writeRunFile(
  directory: string,
  records: readonly WorkspacePathSpillRecord[],
  foldLocale: string,
  cancellation: { isCancelled: () => boolean } | undefined,
  budgetDirectory: string
): Promise<RunFile> {
  return writeRunFileFromIterator(
    directory,
    arrayRecords(records),
    foldLocale,
    cancellation,
    0,
    budgetDirectory
  )
}

export async function writeRunFileFromIterator(
  directory: string,
  records: AsyncIterable<WorkspacePathSpillRecord>,
  foldLocale: string,
  cancellation: { isCancelled: () => boolean } | undefined,
  level: number,
  budgetDirectory: string
): Promise<RunFile> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const tempPath = join(directory, `${randomUUID()}.run.tmp`)
  const finalPath = join(directory, `${randomUUID()}.run`)
  const fileHandle = await open(tempPath, 'wx', 0o600)
  let count = 0
  let previousPath: string | null = null
  let blockRecords: WorkspacePathSpillRecord[] = []
  let blockCodeUnits = 0
  let blocksSinceDiskCheck = 0
  let lastYieldAt = performance.now()
  try {
    const header = Buffer.alloc(RUN_HEADER_BYTES)
    RUN_MAGIC.copy(header)
    header.writeUInt32LE(RUN_VERSION, 8)
    await writeRunBytes(fileHandle, header, null)
    for await (const record of records) {
      checkSpillCancelled(cancellation)
      if (previousPath !== null && compareFileNames(previousPath, record.relativePath) >= 0) {
        throw new Error('Workspace path spill run is not naturally ordered')
      }
      const foldedLength = record.relativePath.toLocaleLowerCase(foldLocale).length
      const recordCodeUnits = record.relativePath.length + foldedLength
      if (recordCodeUnits > WORKSPACE_PATH_CATALOG_BLOCK_CODE_UNIT_LIMIT) {
        throw new Error('A workspace path exceeds the build-run decoded-block limit')
      }
      if (
        blockRecords.length > 0 &&
        (blockRecords.length >= WORKSPACE_PATH_CATALOG_BLOCK_PATH_LIMIT ||
          blockCodeUnits + record.relativePath.length + foldedLength >
            WORKSPACE_PATH_CATALOG_BLOCK_CODE_UNIT_LIMIT)
      ) {
        await writeRunBlock(fileHandle, blockRecords, foldLocale)
        blocksSinceDiskCheck += 1
        if (blocksSinceDiskCheck % 4 === 0 && !(await isWithinDiskBudget(budgetDirectory))) {
          throw new Error('Workspace path build runs exceeded their disk budget')
        }
        blockRecords = []
        blockCodeUnits = 0
      }
      blockRecords.push(record)
      blockCodeUnits += recordCodeUnits
      previousPath = record.relativePath
      count += 1
      if (count % 128 === 0 && performance.now() - lastYieldAt >= 8) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        lastYieldAt = performance.now()
      }
    }
    if (blockRecords.length > 0) {
      await writeRunBlock(fileHandle, blockRecords, foldLocale)
      if (!(await isWithinDiskBudget(budgetDirectory))) {
        throw new Error('Workspace path build runs exceeded their disk budget')
      }
    }
    const countBytes = Buffer.alloc(4)
    countBytes.writeUInt32LE(count)
    await writeRunBytes(fileHandle, countBytes, 12)
    await fileHandle.sync()
    await fileHandle.close()
    await rename(tempPath, finalPath)
    return { path: finalPath, records: count, level }
  } catch (error) {
    await fileHandle.close().catch(() => undefined)
    await rm(tempPath, { force: true }).catch(() => undefined)
    await rm(finalPath, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function writeRunBlock(
  fileHandle: FileHandle,
  records: readonly WorkspacePathSpillRecord[],
  foldLocale: string
): Promise<void> {
  const originals = records.map((record) => record.relativePath)
  const folded = originals.map((path) => path.toLocaleLowerCase(foldLocale))
  const flags = Uint8Array.from(records.map((record) => record.flags))
  const block = encodeWorkspacePathCatalogBlock({ originals, folded, flags })
  if (
    block.originalData.byteLength > RUN_MAX_BLOCK_BYTES ||
    block.foldedData.byteLength > RUN_MAX_BLOCK_BYTES
  ) {
    throw new Error('Workspace path build run exceeded its block size bound')
  }
  const header = Buffer.alloc(RUN_BLOCK_HEADER_BYTES)
  header.writeUInt32LE(records.length, 0)
  header.writeUInt32LE(block.originalData.byteLength, 4)
  header.writeUInt32LE(block.checksums[0], 8)
  header.writeUInt32LE(block.foldedData.byteLength, 12)
  header.writeUInt32LE(block.checksums[1], 16)
  header.writeUInt32LE(block.checksums[2], 20)
  await writeRunBytes(fileHandle, header, null)
  await writeRunBytes(fileHandle, block.originalData, null)
  await writeRunBytes(fileHandle, block.foldedData, null)
  await writeRunBytes(fileHandle, block.flags, null)
}

export async function writeRunBytes(
  fileHandle: FileHandle,
  data: Uint8Array,
  position: number | null
): Promise<void> {
  let offset = 0
  while (offset < data.byteLength) {
    const result = await fileHandle.write(data, offset, data.byteLength - offset, position)
    if (result.bytesWritten <= 0) {
      throw new Error('Workspace path build run write made no progress')
    }
    offset += result.bytesWritten
    if (position !== null) {
      position += result.bytesWritten
    }
  }
}

export async function readRunBytes(
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
      throw new Error('Workspace path build run is truncated')
    }
    offset += result.bytesRead
  }
}

export async function* arrayRecords(
  records: readonly WorkspacePathSpillRecord[]
): AsyncGenerator<WorkspacePathSpillRecord> {
  for (const record of records) {
    yield record
  }
}
