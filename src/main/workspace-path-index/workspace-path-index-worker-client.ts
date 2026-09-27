import type {
  WorkspacePathSearchFenceIdentity,
  WorkspacePathSearchPathSet
} from '../../shared/workspace-path-search-contract'
import type {
  WorkspacePathSearchCorrelationId,
  WorkspacePathSearchInstrumentationEvent
} from '../../shared/workspace-path-search-instrumentation'
import type { WorkspacePathCatalogGeneration } from '../../shared/workspace-path-catalog'
import { workspacePathIndexConsumerKey } from './workspace-path-index-lease'
import type { WorkerThreadFactory } from '../lazy-worker-thread-host'
import type {
  WorkspacePathIndexBuildWorkerResult,
  WorkspacePathIndexDeltaMutation
} from './workspace-path-index-worker-protocol'
import {
  type WorkspacePathIndexWorkerRequestQueue,
  createWorkspacePathIndexWorkerRequestQueue
} from './workspace-path-index-worker-client-queue'
import {
  restoreWorkspacePathCatalogCheckpointInWorker,
  writeWorkspacePathCatalogCheckpointInWorker
} from './workspace-path-index-worker-client-checkpoint'
import { assertWorkerResponse, collectEvents } from './workspace-path-index-worker-response'
import { packPathBatch } from './workspace-path-index-worker-transfer'

export const WORKSPACE_PATH_INDEX_WORKER_MAX_CONSECUTIVE_DEATHS = 3
export {
  createDefaultWorkspacePathIndexWorker,
  WORKSPACE_PATH_INDEX_WORKER_ENTRY_FILENAME
} from './workspace-path-index-worker-client-entry'

export class WorkspacePathIndexWorkerClient {
  private readonly requests: WorkspacePathIndexWorkerRequestQueue
  private readonly activeCancellationIds = new Map<string, string>()
  private readonly onInstrumentation?: (event: WorkspacePathSearchInstrumentationEvent) => void
  private readonly spillDirectory?: string

  constructor(options: {
    workerFactory: WorkerThreadFactory
    log?: (message: string) => void
    onInstrumentation?: (event: WorkspacePathSearchInstrumentationEvent) => void
    spillDirectory?: string
  }) {
    this.onInstrumentation = options.onInstrumentation
    this.spillDirectory = options.spillDirectory
    const log = options.log ?? ((message) => console.warn(message))
    this.requests = createWorkspacePathIndexWorkerRequestQueue({
      workerFactory: options.workerFactory,
      log,
      maxConsecutiveDeaths: WORKSPACE_PATH_INDEX_WORKER_MAX_CONSECUTIVE_DEATHS
    })
  }

  async beginCatalogBuild(args: {
    key: string
    buildId: string
    generationId: string
    firstScope: WorkspacePathSearchPathSet
    maxBytes: number
    correlationId: WorkspacePathSearchCorrelationId
  }): Promise<void> {
    const response = await this.requests.dispatch(
      (id) => ({
        id,
        type: 'begin-build',
        ...args,
        spillDirectory: this.spillDirectory
      }),
      30_000
    )
    assertWorkerResponse(response)
  }

  async appendCatalogPathBatch(
    buildId: string,
    pathSet: WorkspacePathSearchPathSet,
    paths: readonly string[]
  ): Promise<boolean> {
    const packed = packPathBatch(paths)
    const response = await this.requests.dispatch(
      (id) => ({
        id,
        type: 'path-batch',
        buildId,
        pathSet,
        pathsBytes: packed.bytes,
        pathOffsets: packed.offsets,
        pathCount: paths.length
      }),
      30_000
    )
    assertWorkerResponse(response)
    collectEvents(response.events, this.onInstrumentation)
    return response.build?.degradationReason === undefined
  }

  async finishCatalogScope(
    buildId: string,
    pathSet: WorkspacePathSearchPathSet
  ): Promise<WorkspacePathIndexBuildWorkerResult> {
    const response = await this.requests.dispatch(
      (id) => ({ id, type: 'finish-scope', buildId, pathSet }),
      120_000
    )
    assertWorkerResponse(response)
    collectEvents(response.events, this.onInstrumentation)
    if (!response.build) {
      throw new Error('Workspace path index worker returned no build result')
    }
    return response.build
  }

  async abortCatalogBuild(buildId: string, preservePublished = false): Promise<void> {
    this.requests.sendControlMessage({ id: 0, type: 'cancel-build', buildId })
    const response = await this.requests.dispatch(
      (id) => ({ id, type: 'abort-build', buildId, preservePublished }),
      10_000
    )
    assertWorkerResponse(response)
  }

  async install(key: string, generation: WorkspacePathCatalogGeneration): Promise<void> {
    const response = await this.requests.dispatch(
      (id) => ({ id, type: 'install', key, generation }),
      30_000
    )
    assertWorkerResponse(response)
  }

  async restoreCheckpoint(args: { key: string; checkpointDirectory: string }) {
    return restoreWorkspacePathCatalogCheckpointInWorker(this.requests, args)
  }

  async writeCheckpoint(args: {
    key: string
    generationId: string
    checkpointDirectory: string
    maxBytes: number
  }) {
    return writeWorkspacePathCatalogCheckpointInWorker(this.requests, this.spillDirectory, args)
  }

  async applyDelta(args: {
    key: string
    expectedGenerationId: string
    generationId: string
    mutations: readonly WorkspacePathIndexDeltaMutation[]
    freshness: string
    maxBytes: number
    correlationId: WorkspacePathSearchCorrelationId
  }): Promise<{
    generationId: string
    retainedBytes: number
    deltaPathCount: number
    deltaBytes: number
    compacted: boolean
  }> {
    const response = await this.requests.dispatchConcurrent(
      (id) => ({ id, type: 'apply-delta', ...args }),
      120_000
    )
    assertWorkerResponse(response)
    collectEvents(response.events, this.onInstrumentation)
    if (!response.delta) {
      throw new Error('Workspace path index worker returned no delta result')
    }
    return response.delta
  }

  async compact(
    key: string,
    generationId: string,
    maxBytes: number
  ): Promise<{ generationId: string; retainedBytes: number } | null> {
    const response = await this.requests.dispatch(
      (id) => ({ id, type: 'compact', key, generationId, maxBytes }),
      120_000
    )
    assertWorkerResponse(response)
    return response.compacted ?? null
  }

  async spillResidentCatalog(key: string, generationId: string): Promise<number> {
    const response = await this.requests.dispatch(
      (id) => ({
        id,
        type: 'spill-resident',
        key,
        generationId,
        spillDirectory: this.spillDirectory
      }),
      120_000
    )
    assertWorkerResponse(response)
    return response.reclaimedBytes ?? 0
  }

  async discardOptionalStructures(key: string, generationId: string): Promise<number> {
    const response = await this.requests.dispatch(
      (id) => ({ id, type: 'discard-optional', key, generationId }),
      30_000
    )
    assertWorkerResponse(response)
    return response.reclaimedBytes ?? 0
  }

  async drop(key: string, generationId?: string): Promise<void> {
    const response = await this.requests.dispatch(
      (id) => ({ id, type: 'drop', key, ...(generationId ? { generationId } : {}) }),
      10_000
    )
    assertWorkerResponse(response)
  }

  async query(
    key: string,
    identity: WorkspacePathSearchFenceIdentity,
    correlationId: WorkspacePathSearchCorrelationId
  ) {
    const consumerKey = workspacePathIndexConsumerKey(identity)
    const cancellationId = `${consumerKey}:${identity.consumer.sequence}`
    this.activeCancellationIds.set(consumerKey, cancellationId)
    const roundTripStartedAt = performance.now()
    try {
      const response = await this.requests.dispatchConcurrent(
        (id) => ({
          id,
          type: 'query',
          key,
          identity,
          correlationId,
          cancellationId
        }),
        60_000
      )
      assertWorkerResponse(response)
      collectEvents(response.events, this.onInstrumentation)
      if (!response.response) {
        throw new Error('Workspace path index worker returned no response')
      }
      return response.response
    } finally {
      this.onInstrumentation?.({
        kind: 'stage-timing',
        record: {
          correlationId,
          stage: 'worker-round-trip',
          duration: {
            milliseconds: performance.now() - roundTripStartedAt,
            clock: 'execution-host-monotonic'
          }
        }
      })
      if (this.activeCancellationIds.get(consumerKey) === cancellationId) {
        this.activeCancellationIds.delete(consumerKey)
      }
    }
  }

  cancel(consumerKey: string): void {
    const cancellationId = this.activeCancellationIds.get(consumerKey)
    if (cancellationId) {
      this.requests.sendControlMessage({
        id: 0,
        type: 'cancel',
        cancellationId
      })
    }
  }

  dispose(): void {
    this.activeCancellationIds.clear()
    this.requests.dispose()
  }
}

export function createWorkspacePathIndexWorkerClient(
  workerFactory: WorkerThreadFactory,
  log?: (message: string) => void
): WorkspacePathIndexWorkerClient {
  return new WorkspacePathIndexWorkerClient({ workerFactory, log })
}
