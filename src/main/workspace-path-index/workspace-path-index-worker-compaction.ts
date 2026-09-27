import type { WorkspacePathCatalogGeneration } from '../../shared/workspace-path-catalog'
import { compactWorkspacePathCatalogGenerationInWorker } from '../../shared/workspace-path-catalog-compaction-worker'
import type { WorkspacePathSortCancellation } from '../../shared/workspace-path-stable-sort'

export function compactCatalogGenerationInWorker(args: {
  generation: WorkspacePathCatalogGeneration
  generationId: string
  maxBytes: number
  cancellation?: WorkspacePathSortCancellation
}): Promise<WorkspacePathCatalogGeneration | null> {
  return compactWorkspacePathCatalogGenerationInWorker(args.generation, {
    generationId: args.generationId,
    maxBytes: args.maxBytes,
    cancellation: args.cancellation
  })
}
