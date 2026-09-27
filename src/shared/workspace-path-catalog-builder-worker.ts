import type { WorkspacePathCatalog } from './workspace-path-catalog'
import { publishWorkspacePathCatalogInWorker } from './workspace-path-catalog-builder-worker-publication'
import type { WorkspacePathCatalogBuilder } from './workspace-path-catalog-builder'
import type { WorkspacePathSortCancellation } from './workspace-path-stable-sort'

export async function finishWorkspacePathCatalogBuilderInWorker(
  builder: WorkspacePathCatalogBuilder,
  options: { retainPathLookup?: boolean; cancellation?: WorkspacePathSortCancellation } = {}
): Promise<WorkspacePathCatalog | null> {
  const retainPathLookup = options.retainPathLookup ?? false
  const retainedLookupBytes = retainPathLookup ? builder.lookupRetainedBytes : 0
  const naturalOrder = await builder.sortNaturalOrderInWorker({
    retainPathLookup,
    cancellation: options.cancellation
  })
  if (!naturalOrder) {
    builder.markWorkerPublicationFailed()
    return null
  }
  const catalog = await publishWorkspacePathCatalogInWorker({
    ...builder.workerPublicationState(retainedLookupBytes),
    naturalOrder,
    cancellation: options.cancellation
  })
  if (!catalog) {
    builder.markWorkerPublicationFailed()
    return null
  }
  builder.completeWorkerPublication(catalog, retainedLookupBytes, retainPathLookup)
  return catalog
}
