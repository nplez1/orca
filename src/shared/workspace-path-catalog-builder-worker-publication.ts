import type {
  WorkspacePathSearchCorrelationId,
  WorkspacePathSearchInstrumentationEvent
} from './workspace-path-search-instrumentation'
import {
  workspacePathCatalogRetainedBytes,
  type WorkspacePathCatalog,
  type WorkspacePathCatalogMetadata
} from './workspace-path-catalog'
import type { WorkspacePathSortCancellation } from './workspace-path-stable-sort'
import type {
  WorkspacePathCatalogBuildRecord,
  WorkspacePathCatalogStorage
} from './workspace-path-catalog-builder'
import {
  publishWorkspacePathCatalog,
  workspacePathCatalogBuildFits
} from './workspace-path-catalog-builder-publication'
import { buildWorkspacePathCatalogTrigramPostings } from './workspace-path-catalog-trigram'

export async function publishWorkspacePathCatalogInWorker(args: {
  records: readonly WorkspacePathCatalogBuildRecord[]
  generationId: string
  storage: WorkspacePathCatalogStorage
  metadata: WorkspacePathCatalogMetadata
  originalUtf8Length: number
  foldedCodeUnitCount: number
  naturalOrder: Uint32Array
  retainedLookupBytes: number
  reservedBuildBytes: number
  maxBytes: number
  correlationId: WorkspacePathSearchCorrelationId
  onInstrumentation?: (event: WorkspacePathSearchInstrumentationEvent) => void
  cancellation?: WorkspacePathSortCancellation
}): Promise<WorkspacePathCatalog | null> {
  if (!workspacePathCatalogBuildFits(args)) {
    return null
  }
  if (args.storage === 'prefix-compressed') {
    if (args.cancellation?.isCancelled()) {
      throw new Error('Workspace path catalog build was cancelled')
    }
    const catalog = publishWorkspacePathCatalog({ ...args, naturalOrder: args.naturalOrder })
    if (args.cancellation?.isCancelled()) {
      throw new Error('Workspace path catalog build was cancelled')
    }
    return catalog
  }
  const startedAt = performance.now()
  const pathCount = args.records.length
  const originalUtf8 = new Uint8Array(args.originalUtf8Length)
  const encoder = new TextEncoder()
  const originalOffsets = new Uint32Array(pathCount + 1)
  const foldedOffsets = new Uint32Array(pathCount + 1)
  const flags = new Uint8Array(pathCount)
  const foldedPaths: string[] = []
  const foldedCodeUnits =
    args.storage === 'packed-folded' ? new Uint16Array(args.foldedCodeUnitCount) : null
  let originalOffset = 0
  let foldedOffset = 0
  let lastYieldAt = performance.now()

  for (let id = 0; id < pathCount; id += 1) {
    if (args.cancellation?.isCancelled()) {
      throw new Error('Workspace path catalog build was cancelled')
    }
    const record = args.records[id]
    if (record) {
      originalOffsets[id] = originalOffset
      foldedOffsets[id] = foldedOffset
      encoder.encodeInto(record.relativePath, originalUtf8.subarray(originalOffset))
      originalOffset += record.originalUtf8Length
      foldedOffset += record.foldedPath.length
      flags[id] = record.flags
      if (foldedCodeUnits) {
        for (let index = 0; index < record.foldedPath.length; index += 1) {
          foldedCodeUnits[foldedOffsets[id]! + index] = record.foldedPath.charCodeAt(index)
        }
      } else {
        foldedPaths.push(record.foldedPath)
      }
    }
    if (id % 256 === 0 && performance.now() - lastYieldAt >= 8) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      lastYieldAt = performance.now()
    }
  }
  originalOffsets[pathCount] = originalOffset
  foldedOffsets[pathCount] = foldedOffset
  const retainedBytes = workspacePathCatalogRetainedBytes(
    originalUtf8.byteLength,
    foldedOffsets,
    args.naturalOrder,
    flags,
    originalOffsets,
    foldedCodeUnits
      ? { kind: 'packed-folded', codeUnits: foldedCodeUnits }
      : { kind: 'folded-strings', paths: foldedPaths }
  )
  if (retainedBytes + args.retainedLookupBytes > args.maxBytes) {
    return null
  }
  const baseCatalog: WorkspacePathCatalog = foldedCodeUnits
    ? {
        generationId: args.generationId,
        metadata: args.metadata,
        pathCount,
        originalUtf8,
        originalOffsets,
        foldedOffsets,
        naturalOrder: args.naturalOrder,
        flags,
        retainedBytes,
        storageKind: 'packed-folded',
        foldedCodeUnits
      }
    : {
        generationId: args.generationId,
        metadata: args.metadata,
        pathCount,
        originalUtf8,
        originalOffsets,
        foldedOffsets,
        naturalOrder: args.naturalOrder,
        flags,
        retainedBytes,
        storageKind: 'folded-strings',
        foldedPaths
      }
  const retainedLookupBytes = args.retainedLookupBytes
  const availableBytes = Math.max(
    0,
    args.maxBytes - Math.max(args.reservedBuildBytes, retainedBytes + retainedLookupBytes)
  )
  const trigramPostings = buildWorkspacePathCatalogTrigramPostings({
    records: args.records,
    naturalOrder: args.naturalOrder,
    scratchBudgetBytes: Math.min(512 * 1024 * 1024, availableBytes),
    retainedBudgetBytes: Math.max(0, args.maxBytes - retainedBytes - retainedLookupBytes)
  })
  const catalog: WorkspacePathCatalog = trigramPostings
    ? {
        ...baseCatalog,
        trigramPostings,
        retainedBytes: retainedBytes + trigramPostings.retainedBytes
      }
    : baseCatalog
  args.onInstrumentation?.({
    kind: 'stage-timing',
    record: {
      correlationId: args.correlationId,
      stage: 'index-publication',
      duration: { milliseconds: performance.now() - startedAt, clock: 'execution-host-monotonic' }
    }
  })
  return catalog
}
