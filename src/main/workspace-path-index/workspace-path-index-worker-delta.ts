import {
  isWorkspacePathCatalogCompactionDue,
  WorkspacePathCatalogOverlayBuilder
} from '../../shared/workspace-path-catalog-overlay'
import type { WorkspacePathCatalogGeneration } from '../../shared/workspace-path-catalog'
import type { WorkspacePathSearchInstrumentationEvent } from '../../shared/workspace-path-search-instrumentation'
import { compactCatalogGenerationInWorker } from './workspace-path-index-worker-compaction'
import {
  publishWorkspacePathIndexWorkerGeneration,
  workspacePathIndexWorkerGenerationKey
} from './workspace-path-index-worker-generation'
import type {
  WorkspacePathIndexWorkerRequest,
  WorkspacePathIndexWorkerResponse
} from './workspace-path-index-worker-protocol'
import { applyWorkspacePathIndexSpilledDelta } from './workspace-path-index-worker-spilled-delta'

type ApplyDeltaRequest = Extract<WorkspacePathIndexWorkerRequest, { type: 'apply-delta' }>

type ApplyDeltaDependencies = {
  generations: Map<string, WorkspacePathCatalogGeneration>
  latestGenerationIds: Map<string, string>
}

export async function applyWorkspacePathIndexDelta(
  request: ApplyDeltaRequest,
  dependencies: ApplyDeltaDependencies
): Promise<WorkspacePathIndexWorkerResponse> {
  const currentId = dependencies.latestGenerationIds.get(request.key)
  if (currentId !== request.expectedGenerationId) {
    throw new Error('Workspace path index delta generation was superseded')
  }
  const current = dependencies.generations.get(
    workspacePathIndexWorkerGenerationKey(request.key, currentId)
  )
  if (!current) {
    throw new Error('Workspace path index delta generation is unavailable')
  }
  if (current.catalog.storageKind === 'disk-spilled') {
    return applyWorkspacePathIndexSpilledDelta(request, dependencies, current.catalog)
  }
  const startedAt = performance.now()
  const builder = new WorkspacePathCatalogOverlayBuilder(current.catalog, {
    generationId: request.generationId,
    maxBytes: Math.max(0, request.maxBytes - current.catalog.retainedBytes),
    previousOverlay: current.overlay,
    correlationId: request.correlationId
  })
  for (const mutation of request.mutations) {
    if (mutation.type === 'add') {
      builder.addPath(mutation.path, mutation.pathSet)
    } else if (mutation.type === 'upsert') {
      builder.upsertPath(mutation.path, mutation.flags)
    } else if (mutation.type === 'delete-prefix') {
      builder.deletePathPrefix(mutation.path)
    } else {
      builder.deletePath(mutation.path)
    }
    if (builder.isOverBudget) {
      throw new Error('Workspace path index delta exceeded its memory budget')
    }
  }
  builder.setFreshness(request.freshness)
  let overlay = await builder.finishInWorker()
  if (!overlay) {
    throw new Error('Workspace path index delta could not be published')
  }
  let generation: WorkspacePathCatalogGeneration = { catalog: current.catalog, overlay }
  let compacted = false
  const events: WorkspacePathSearchInstrumentationEvent[] = [
    {
      kind: 'maintenance',
      record: {
        correlationId: request.correlationId,
        action: 'delta-applied',
        pathCount: request.mutations.length,
        byteCount: overlay.deltaBytes,
        durationMilliseconds: performance.now() - startedAt
      }
    }
  ]
  if (isWorkspacePathCatalogCompactionDue(generation)) {
    events.push({
      kind: 'maintenance',
      record: {
        correlationId: request.correlationId,
        action: 'compaction-triggered',
        pathCount: overlay.delta.length,
        byteCount: overlay.deltaBytes,
        durationMilliseconds: 0
      }
    })
    const compactedGeneration = await compactCatalogGenerationInWorker({
      generation,
      generationId: `${request.generationId}:compacted`,
      maxBytes: request.maxBytes
    })
    if (compactedGeneration) {
      generation = compactedGeneration
      overlay = compactedGeneration.overlay ?? overlay
      compacted = true
    }
  }
  if (dependencies.latestGenerationIds.get(request.key) !== request.expectedGenerationId) {
    throw new Error('Workspace path index delta generation was superseded before publication')
  }
  const generationId = generation.overlay?.generationId ?? generation.catalog.generationId
  publishWorkspacePathIndexWorkerGeneration({
    generations: dependencies.generations,
    latestGenerationIds: dependencies.latestGenerationIds,
    rootKey: request.key,
    generationId,
    generation
  })
  return {
    id: request.id,
    ok: true,
    delta: {
      generationId,
      retainedBytes: generation.catalog.retainedBytes + (generation.overlay?.retainedBytes ?? 0),
      deltaPathCount: overlay.delta.length,
      deltaBytes: overlay.deltaBytes,
      compacted
    },
    events
  }
}
