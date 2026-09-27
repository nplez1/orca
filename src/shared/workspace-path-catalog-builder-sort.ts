import type {
  WorkspacePathSearchCorrelationId,
  WorkspacePathSearchInstrumentationEvent
} from './workspace-path-search-instrumentation'
import { compareFileNames } from './file-name-sort'
import { workspacePathCatalogBuildFits } from './workspace-path-catalog-builder-publication'
import type {
  WorkspacePathCatalogBuildRecord,
  WorkspacePathCatalogStorage
} from './workspace-path-catalog-builder'
import {
  stableSortWorkspacePathIds,
  type WorkspacePathSortCancellation
} from './workspace-path-stable-sort'

export async function sortWorkspacePathCatalogRecords(args: {
  records: readonly WorkspacePathCatalogBuildRecord[]
  storage: WorkspacePathCatalogStorage
  originalUtf8Length: number
  foldedCodeUnitCount: number
  retainedLookupBytes: number
  reservedBuildBytes: number
  maxBytes: number
  correlationId: WorkspacePathSearchCorrelationId
  onInstrumentation?: (event: WorkspacePathSearchInstrumentationEvent) => void
  cancellation?: WorkspacePathSortCancellation
}): Promise<Uint32Array | null> {
  if (!workspacePathCatalogBuildFits(args)) {
    return null
  }
  const startedAt = performance.now()
  const ids = Uint32Array.from({ length: args.records.length }, (_value, index) => index)
  const naturalOrder = await stableSortWorkspacePathIds(
    ids,
    (leftId, rightId) =>
      compareFileNames(
        args.records[leftId]?.relativePath ?? '',
        args.records[rightId]?.relativePath ?? ''
      ),
    args.cancellation
  )
  args.onInstrumentation?.({
    kind: 'stage-timing',
    record: {
      correlationId: args.correlationId,
      stage: 'sort',
      duration: { milliseconds: performance.now() - startedAt, clock: 'execution-host-monotonic' }
    }
  })
  return naturalOrder
}
