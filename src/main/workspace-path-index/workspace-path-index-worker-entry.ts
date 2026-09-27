import { parentPort } from 'node:worker_threads'
import type { WorkspacePathCatalogGeneration } from '../../shared/workspace-path-catalog'
import {
  queryWorkspacePathCatalog,
  WorkspacePathSearchCancelledError
} from '../../shared/workspace-path-catalog-query'
import { WORKSPACE_PATH_PROVISIONAL_PAGE_BUDGET } from '../../shared/workspace-path-provisional-page-budget'
import { openWorkspacePathCatalogSpillReader } from './workspace-path-catalog-spill'
import { handleWorkspacePathIndexCheckpointRequest } from './workspace-path-index-worker-checkpoint'
import type { WorkspacePathSearchInstrumentationEvent } from '../../shared/workspace-path-search-instrumentation'
import { WorkspacePathIndexWorkerBuildLane } from './workspace-path-index-worker-build-lane'
import { applyWorkspacePathIndexDelta } from './workspace-path-index-worker-delta'
import {
  dropWorkspacePathIndexWorkerGeneration,
  dropWorkspacePathIndexWorkerRoot,
  publishWorkspacePathIndexWorkerGeneration,
  workspacePathIndexWorkerGenerationKey
} from './workspace-path-index-worker-generation'
import type {
  WorkspacePathIndexWorkerRequest,
  WorkspacePathIndexWorkerResponse
} from './workspace-path-index-worker-protocol'

if (!parentPort) {
  throw new Error('Workspace path index worker requires a parent port')
}

const port = parentPort
const generations = new Map<string, WorkspacePathCatalogGeneration>()
const latestGenerationIds = new Map<string, string>()
const buildLane = new WorkspacePathIndexWorkerBuildLane(generations, latestGenerationIds)
const cancelledQueries = new Set<string>()

port.on('message', (request: WorkspacePathIndexWorkerRequest) => {
  if (request.type === 'cancel') {
    cancelledQueries.add(request.cancellationId)
    spilledQueryGate.wakeWaiters()
    return
  }
  if (request.type === 'cancel-build') {
    buildLane.cancel(request.buildId)
    return
  }
  if (request.type === 'restore-checkpoint' || request.type === 'write-checkpoint') {
    void handleWorkspacePathIndexCheckpointRequest(request, generations, latestGenerationIds).then(
      (response) => {
        port.postMessage(response)
      }
    )
    return
  }
  void handleRequest(request).then((response) => {
    try {
      port.postMessage(response)
    } catch {
      port.postMessage({
        id: request.id,
        ok: false,
        error: 'Worker response was not serializable.'
      })
    }
  })
})

async function handleRequest(
  request: Exclude<
    WorkspacePathIndexWorkerRequest,
    {
      type: 'cancel' | 'cancel-build' | 'restore-checkpoint' | 'write-checkpoint'
    }
  >
): Promise<WorkspacePathIndexWorkerResponse> {
  try {
    switch (request.type) {
      case 'install': {
        const generationId =
          request.generation.overlay?.generationId ?? request.generation.catalog.generationId
        publishWorkspacePathIndexWorkerGeneration({
          generations,
          latestGenerationIds,
          rootKey: request.key,
          generationId,
          generation: request.generation
        })
        return { id: request.id, ok: true }
      }
      case 'apply-delta':
        return await applyWorkspacePathIndexDelta(request, {
          generations,
          latestGenerationIds
        })
      case 'begin-build':
        await buildLane.begin(request)
        return { id: request.id, ok: true }
      case 'path-batch': {
        const result = await buildLane.addBatch(
          request.buildId,
          request.pathSet,
          request.pathsBytes,
          request.pathOffsets,
          request.pathCount
        )
        return {
          id: request.id,
          ok: true,
          ...(!result.accepted
            ? {
                build: {
                  ...result,
                  buildId: request.buildId,
                  complete: false,
                  degradationReason: 'over-budget'
                }
              }
            : {})
        }
      }
      case 'finish-scope': {
        const result = await buildLane.finishScope(request.buildId, request.pathSet)
        return {
          id: request.id,
          ok: true,
          build: result.build,
          events: result.events
        }
      }
      case 'abort-build':
        buildLane.abort(request.buildId, request.preservePublished)
        return { id: request.id, ok: true }
      case 'compact': {
        const compacted = await buildLane.compact(
          request.key,
          request.generationId,
          request.maxBytes
        )
        return {
          id: request.id,
          ok: true,
          ...(compacted ? { compacted } : {})
        }
      }
      case 'drop':
        if (request.generationId) {
          dropWorkspacePathIndexWorkerGeneration({
            generations,
            latestGenerationIds,
            rootKey: request.key,
            generationId: request.generationId
          })
        } else {
          dropWorkspacePathIndexWorkerRoot({
            generations,
            latestGenerationIds,
            rootKey: request.key
          })
        }
        return { id: request.id, ok: true }
      case 'discard-optional':
        return {
          id: request.id,
          ok: true,
          reclaimedBytes: buildLane.discardOptionalStructures(request.key, request.generationId)
        }
      case 'spill-resident':
        return {
          id: request.id,
          ok: true,
          reclaimedBytes: await buildLane.spillResidentCatalog(
            request.key,
            request.generationId,
            request.spillDirectory
          )
        }
      case 'query':
        return await runQuery(request)
    }
  } catch (error) {
    if (request.type === 'query') {
      cancelledQueries.delete(request.cancellationId)
    }
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : 'Workspace path index worker failed.'
    }
  }
}

async function runQuery(
  request: Extract<WorkspacePathIndexWorkerRequest, { type: 'query' }>
): Promise<WorkspacePathIndexWorkerResponse> {
  const generationId = request.identity.generationId ?? latestGenerationIds.get(request.key)
  const generation = generationId
    ? generations.get(workspacePathIndexWorkerGenerationKey(request.key, generationId))
    : undefined
  if (!generation) {
    throw new Error('Workspace path catalog generation is unavailable')
  }
  const events: WorkspacePathSearchInstrumentationEvent[] = []
  const queryOptions = {
    identity: request.identity,
    correlationId: request.correlationId,
    cancellation: {
      isCancelled: () => cancelledQueries.has(request.cancellationId)
    },
    onInstrumentation: (event: WorkspacePathSearchInstrumentationEvent) => events.push(event),
    yieldToWorker: yieldToWorkerThread,
    // A restored checkpoint must not pay a multi-second full scan to paint its first page.
    ...(generation.provisionalLastKnown
      ? { provisionalPageBudget: WORKSPACE_PATH_PROVISIONAL_PAGE_BUDGET }
      : {})
  }
  let response
  if (generation.catalog.storageKind === 'disk-spilled') {
    const diskCatalog = generation.catalog
    response = await spilledQueryGate.run(
      { isCancelled: () => cancelledQueries.has(request.cancellationId) },
      async () => {
        const spillReader = await openWorkspacePathCatalogSpillReader(diskCatalog)
        try {
          return await queryWorkspacePathCatalog(generation, {
            ...queryOptions,
            readSpilledBlock: spillReader.readBlock
          })
        } finally {
          await spillReader.close()
        }
      }
    )
  } else {
    response = await queryWorkspacePathCatalog(generation, queryOptions)
  }
  cancelledQueries.delete(request.cancellationId)
  return { id: request.id, ok: true, response, events }
}

function yieldToWorkerThread(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

type SpillCancellation = { isCancelled: () => boolean }

/** Limits decoded spill blocks to one active query per worker; queued cancellation stays responsive. */
class WorkspacePathCatalogSpillQueryGate {
  private active = false
  private readonly waiters = new Set<() => void>()

  async run<T>(cancellation: SpillCancellation, task: () => Promise<T>): Promise<T> {
    await this.acquire(cancellation)
    try {
      return await task()
    } finally {
      this.active = false
      this.wakeWaiters()
    }
  }

  wakeWaiters(): void {
    for (const wake of this.waiters) {
      wake()
    }
  }

  private async acquire(cancellation: SpillCancellation): Promise<void> {
    while (this.active) {
      if (cancellation.isCancelled()) {
        throw new WorkspacePathSearchCancelledError()
      }
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>
        const wake = (): void => {
          clearTimeout(timer)
          this.waiters.delete(wake)
          resolve()
        }
        this.waiters.add(wake)
        timer = setTimeout(wake, 5)
      })
    }
    if (cancellation.isCancelled()) {
      throw new WorkspacePathSearchCancelledError()
    }
    this.active = true
  }
}

const spilledQueryGate = new WorkspacePathCatalogSpillQueryGate()
