import { stat } from 'node:fs/promises'
import { WORKSPACE_PATH_CATALOG_FLAGS } from '../../shared/workspace-path-catalog'
import { compareFileNames } from '../../shared/file-name-sort'
import type { WorkspacePathSpillRecord } from './workspace-path-catalog-spill'
import { checkSpillCancelled, type RunFile } from './workspace-path-catalog-spill-runs-file-writer'
import { RunCursor } from './workspace-path-catalog-spill-runs-run-cursor'
import {
  SPILL_DISK_BUDGET_BYTES,
  directorySizeBytes
} from './workspace-path-catalog-spill-runs-disk-budget'

export const RUN_MERGE_FAN_IN = 16

export async function countMergedRunRecords(
  files: readonly RunFile[],
  directory: string,
  cancellation?: { isCancelled: () => boolean }
): Promise<number> {
  let count = 0
  for await (const _record of mergeRunFiles(files, directory, cancellation)) {
    count += 1
  }
  return count
}

export async function* classifyCompleteCatalogRecords(
  records: AsyncIterable<WorkspacePathSpillRecord>,
  cancellation?: { isCancelled: () => boolean }
): AsyncGenerator<WorkspacePathSpillRecord> {
  let processed = 0
  for await (const record of records) {
    if (processed % 32 === 0) {
      checkSpillCancelled(cancellation)
    }
    const included = (record.flags & WORKSPACE_PATH_CATALOG_FLAGS.included) !== 0
    let flags = record.flags | WORKSPACE_PATH_CATALOG_FLAGS.ignoreClassificationKnown
    flags = included
      ? flags & ~WORKSPACE_PATH_CATALOG_FLAGS.ignored
      : flags | WORKSPACE_PATH_CATALOG_FLAGS.ignored
    yield { relativePath: record.relativePath, flags }
    processed += 1
  }
}

export async function* mergeRunFiles(
  files: readonly RunFile[],
  directory: string,
  cancellation?: { isCancelled: () => boolean }
): AsyncGenerator<WorkspacePathSpillRecord> {
  const cursors: RunCursor[] = []
  try {
    for (const file of files) {
      const cursor = await RunCursor.open(file.path)
      cursors.push(cursor)
      await cursor.advance()
    }
    let currentPath: string | null = null
    let currentFlags = 0
    let recordsSeen = 0
    let lastYieldAt = performance.now()
    while (true) {
      let nextCursor: RunCursor | null = null
      let nextRecord: WorkspacePathSpillRecord | null = null
      for (const cursor of cursors) {
        const candidate = cursor.current
        if (!candidate) {
          continue
        }
        if (!nextRecord || compareFileNames(candidate.relativePath, nextRecord.relativePath) < 0) {
          nextCursor = cursor
          nextRecord = candidate
        }
      }
      if (!nextCursor || !nextRecord) {
        break
      }
      const next = nextRecord
      await nextCursor.advance()
      if (currentPath === next.relativePath) {
        currentFlags |= next.flags
      } else {
        if (currentPath !== null) {
          yield { relativePath: currentPath, flags: currentFlags }
        }
        currentPath = next.relativePath
        currentFlags = next.flags
      }
      recordsSeen += 1
      if (recordsSeen % 64 === 0 && performance.now() - lastYieldAt >= 8) {
        checkSpillCancelled(cancellation)
        await new Promise<void>((resolve) => setImmediate(resolve))
        lastYieldAt = performance.now()
      }
    }
    if (currentPath !== null) {
      yield { relativePath: currentPath, flags: currentFlags }
    }
  } finally {
    await Promise.all(cursors.map((cursor) => cursor.close()))
  }
  void directory
}

export function nextFullRunLevel(files: readonly RunFile[]): number | null {
  const counts = new Map<number, number>()
  for (const file of files) {
    const count = (counts.get(file.level) ?? 0) + 1
    if (count >= RUN_MERGE_FAN_IN) {
      return file.level
    }
    counts.set(file.level, count)
  }
  return null
}

export async function canMergeRunFiles(
  directory: string,
  files: readonly RunFile[]
): Promise<boolean> {
  let mergeBytes = 0
  for (const file of files) {
    mergeBytes += (await stat(file.path)).size
  }
  return (await directorySizeBytes(directory)) + mergeBytes <= SPILL_DISK_BUDGET_BYTES
}
