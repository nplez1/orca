import type {
  WorkspacePathSearchCorrelationId,
  WorkspacePathSearchInstrumentationEvent
} from './workspace-path-search-instrumentation'
import {
  workspacePathCatalogRetainedBytes,
  type WorkspacePathCatalog,
  type WorkspacePathCatalogMetadata
} from './workspace-path-catalog'
import { compareFileNames } from './file-name-sort'
import { buildWorkspacePathCatalogTrigramPostings } from './workspace-path-catalog-trigram'
import type {
  WorkspacePathCatalogBuildRecord,
  WorkspacePathCatalogStorage
} from './workspace-path-catalog-builder'
import { buildWorkspacePathCatalogPrefixBlocks } from './workspace-path-catalog-blocks'

export function publishWorkspacePathCatalog(args: {
  records: readonly WorkspacePathCatalogBuildRecord[]
  generationId: string
  storage: WorkspacePathCatalogStorage
  metadata: WorkspacePathCatalogMetadata
  originalUtf8Length: number
  foldedCodeUnitCount: number
  retainedLookupBytes: number
  reservedBuildBytes: number
  maxBytes: number
  naturalOrder?: Uint32Array
  correlationId: WorkspacePathSearchCorrelationId
  onInstrumentation?: (event: WorkspacePathSearchInstrumentationEvent) => void
}): WorkspacePathCatalog | null {
  if (!workspacePathCatalogBuildFits(args)) {
    return null
  }
  const naturalOrder = args.naturalOrder ?? sortNaturalOrder(args.records, args)
  if (args.storage === 'prefix-compressed') {
    return publishPrefixCompressedWorkspacePathCatalog(args, naturalOrder)
  }

  const publishStartedAt = performance.now()
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

  for (let id = 0; id < pathCount; id += 1) {
    const record = args.records[id]
    if (!record) {
      continue
    }
    originalOffsets[id] = originalOffset
    foldedOffsets[id] = foldedOffset
    encoder.encodeInto(record.relativePath, originalUtf8.subarray(originalOffset))
    originalOffset += record.originalUtf8Length
    foldedOffset += record.foldedPath.length
    flags[id] = record.flags
    if (foldedCodeUnits) {
      const foldedStart = foldedOffsets[id] ?? 0
      for (let index = 0; index < record.foldedPath.length; index += 1) {
        foldedCodeUnits[foldedStart + index] = record.foldedPath.charCodeAt(index)
      }
    } else {
      foldedPaths.push(record.foldedPath)
    }
  }
  originalOffsets[pathCount] = originalOffset
  foldedOffsets[pathCount] = foldedOffset
  const retainedBytes = workspacePathCatalogRetainedBytes(
    originalUtf8.byteLength,
    foldedOffsets,
    naturalOrder,
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
        naturalOrder,
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
        naturalOrder,
        flags,
        retainedBytes,
        storageKind: 'folded-strings',
        foldedPaths
      }
  const trigramPostings = buildWorkspacePathCatalogTrigramPostings({
    records: args.records,
    naturalOrder,
    scratchBudgetBytes: Math.min(
      512 * 1024 * 1024,
      Math.max(
        0,
        args.maxBytes - Math.max(args.reservedBuildBytes, retainedBytes + args.retainedLookupBytes)
      )
    ),
    retainedBudgetBytes: Math.max(0, args.maxBytes - retainedBytes - args.retainedLookupBytes)
  })
  const catalog: WorkspacePathCatalog = trigramPostings
    ? {
        ...baseCatalog,
        trigramPostings,
        retainedBytes: retainedBytes + trigramPostings.retainedBytes
      }
    : baseCatalog
  emitStage(args, 'index-publication', performance.now() - publishStartedAt)
  return catalog
}

function publishPrefixCompressedWorkspacePathCatalog(
  args: {
    records: readonly WorkspacePathCatalogBuildRecord[]
    generationId: string
    metadata: WorkspacePathCatalogMetadata
    retainedLookupBytes: number
    reservedBuildBytes: number
    maxBytes: number
    correlationId: WorkspacePathSearchCorrelationId
    onInstrumentation?: (event: WorkspacePathSearchInstrumentationEvent) => void
  },
  naturalOrder: Uint32Array
): WorkspacePathCatalog | null {
  const publishStartedAt = performance.now()
  const pathCount = args.records.length
  const originalOffsets = new Uint32Array(pathCount + 1)
  const foldedOffsets = new Uint32Array(pathCount + 1)
  const flags = new Uint8Array(pathCount)
  let originalOffset = 0
  let foldedOffset = 0
  for (let id = 0; id < pathCount; id += 1) {
    const record = args.records[id]
    if (!record) {
      continue
    }
    originalOffsets[id] = originalOffset
    foldedOffsets[id] = foldedOffset
    originalOffset += record.originalUtf8Length
    foldedOffset += record.foldedPath.length
    flags[id] = record.flags
  }
  originalOffsets[pathCount] = originalOffset
  foldedOffsets[pathCount] = foldedOffset
  const prefixBlocks = buildWorkspacePathCatalogPrefixBlocks(args.records, naturalOrder)
  const retainedBytes = workspacePathCatalogRetainedBytes(
    0,
    foldedOffsets,
    naturalOrder,
    flags,
    originalOffsets,
    {
      kind: 'prefix-compressed',
      blockDataBytes:
        prefixBlocks.originalBlockData.byteLength + prefixBlocks.foldedBlockData.byteLength,
      naturalRanks: prefixBlocks.naturalRanks,
      originalBlockOffsets: prefixBlocks.originalBlockOffsets,
      originalBlockChecksums: prefixBlocks.originalBlockChecksums,
      foldedBlockOffsets: prefixBlocks.foldedBlockOffsets,
      foldedBlockChecksums: prefixBlocks.foldedBlockChecksums,
      rankBlockOffsets: prefixBlocks.rankBlockOffsets
    }
  )
  if (retainedBytes + args.retainedLookupBytes > args.maxBytes) {
    return null
  }
  const baseCatalog: WorkspacePathCatalog = {
    generationId: args.generationId,
    metadata: args.metadata,
    pathCount,
    originalOffsets,
    foldedOffsets,
    naturalOrder,
    flags,
    retainedBytes,
    storageKind: 'prefix-compressed',
    ...prefixBlocks
  }
  const trigramPostings = buildWorkspacePathCatalogTrigramPostings({
    records: args.records,
    naturalOrder,
    scratchBudgetBytes: Math.min(
      512 * 1024 * 1024,
      Math.max(
        0,
        args.maxBytes - Math.max(args.reservedBuildBytes, retainedBytes + args.retainedLookupBytes)
      )
    ),
    retainedBudgetBytes: Math.max(0, args.maxBytes - retainedBytes - args.retainedLookupBytes)
  })
  const catalog: WorkspacePathCatalog = trigramPostings
    ? {
        ...baseCatalog,
        trigramPostings,
        retainedBytes: retainedBytes + trigramPostings.retainedBytes
      }
    : baseCatalog
  emitStage(args, 'index-publication', performance.now() - publishStartedAt)
  return catalog
}

export function workspacePathCatalogBuildFits(args: {
  records: readonly WorkspacePathCatalogBuildRecord[]
  storage: WorkspacePathCatalogStorage
  originalUtf8Length: number
  foldedCodeUnitCount: number
  retainedLookupBytes: number
  reservedBuildBytes: number
  maxBytes: number
}): boolean {
  if (args.storage === 'prefix-compressed') {
    return Math.max(args.reservedBuildBytes, args.retainedLookupBytes) <= args.maxBytes
  }
  return (
    Math.max(args.reservedBuildBytes, estimateCatalogBytes(args) + args.retainedLookupBytes) <=
    args.maxBytes
  )
}

function sortNaturalOrder(
  records: readonly WorkspacePathCatalogBuildRecord[],
  instrumentation: {
    correlationId: WorkspacePathSearchCorrelationId
    onInstrumentation?: (event: WorkspacePathSearchInstrumentationEvent) => void
  }
): Uint32Array {
  const sortStartedAt = performance.now()
  const sortedIds = records.map((_record, id) => id)
  sortedIds.sort((leftId, rightId) =>
    compareFileNames(records[leftId]?.relativePath ?? '', records[rightId]?.relativePath ?? '')
  )
  emitStage(instrumentation, 'sort', performance.now() - sortStartedAt)
  return Uint32Array.from(sortedIds)
}

function estimateCatalogBytes(args: {
  records: readonly WorkspacePathCatalogBuildRecord[]
  storage: WorkspacePathCatalogStorage
  originalUtf8Length: number
  foldedCodeUnitCount: number
}): number {
  const pathCount = args.records.length
  let foldedStringBytes = 0
  for (const record of args.records) {
    foldedStringBytes += record.foldedPath.length * 2 + 48
  }
  const numericBytes = args.originalUtf8Length + (pathCount + 1) * 8 + pathCount * 5 + 256
  return args.storage === 'packed-folded'
    ? numericBytes + args.foldedCodeUnitCount * 2
    : numericBytes + foldedStringBytes + pathCount * 8
}

function emitStage(
  args: {
    correlationId: WorkspacePathSearchCorrelationId
    onInstrumentation?: (event: WorkspacePathSearchInstrumentationEvent) => void
  },
  stage: 'sort' | 'index-publication',
  milliseconds: number
): void {
  args.onInstrumentation?.({
    kind: 'stage-timing',
    record: {
      correlationId: args.correlationId,
      stage,
      duration: { milliseconds, clock: 'execution-host-monotonic' }
    }
  })
}
