import type {
  WorkspacePathSearchFenceIdentity,
  WorkspacePathSearchPathSet,
  WorkspacePathSearchResponse
} from '../../shared/workspace-path-search-contract'
import type { WorkspacePathCatalogGeneration } from '../../shared/workspace-path-catalog'
import type {
  WorkspacePathSearchCorrelationId,
  WorkspacePathSearchInstrumentationEvent
} from '../../shared/workspace-path-search-instrumentation'

export type WorkspacePathIndexDeltaMutation =
  | { type: 'add'; path: string; pathSet: WorkspacePathSearchPathSet }
  | { type: 'upsert'; path: string; flags: number }
  | { type: 'delete'; path: string }
  | { type: 'delete-prefix'; path: string }

export type WorkspacePathIndexWorkerRequest =
  | {
      id: number
      type: 'install'
      key: string
      generation: WorkspacePathCatalogGeneration
    }
  | {
      id: number
      type: 'apply-delta'
      key: string
      expectedGenerationId: string
      generationId: string
      mutations: readonly WorkspacePathIndexDeltaMutation[]
      freshness: string
      maxBytes: number
      correlationId: string
    }
  | {
      id: number
      type: 'begin-build'
      key: string
      buildId: string
      generationId: string
      firstScope: WorkspacePathSearchPathSet
      maxBytes: number
      spillDirectory?: string
      correlationId: WorkspacePathSearchCorrelationId
    }
  | {
      id: number
      type: 'path-batch'
      buildId: string
      pathSet: WorkspacePathSearchPathSet
      pathsBytes: ArrayBuffer
      pathOffsets: Uint32Array
      pathCount: number
    }
  | {
      id: number
      type: 'finish-scope'
      buildId: string
      pathSet: WorkspacePathSearchPathSet
    }
  | {
      id: number
      type: 'abort-build'
      buildId: string
      preservePublished: boolean
    }
  | {
      id: number
      type: 'query'
      key: string
      identity: WorkspacePathSearchFenceIdentity
      correlationId: WorkspacePathSearchCorrelationId
      cancellationId: string
    }
  | {
      id: number
      type: 'compact'
      key: string
      generationId: string
      maxBytes: number
    }
  | { id: number; type: 'drop'; key: string; generationId?: string }
  | { id: number; type: 'discard-optional'; key: string; generationId: string }
  | {
      id: number
      type: 'spill-resident'
      key: string
      generationId: string
      spillDirectory?: string
    }
  | { id: number; type: 'cancel'; cancellationId: string }
  | { id: number; type: 'cancel-build'; buildId: string }
  | {
      id: number
      type: 'restore-checkpoint'
      key: string
      checkpointDirectory: string
    }
  | {
      id: number
      type: 'write-checkpoint'
      key: string
      generationId: string
      checkpointDirectory: string
      maxBytes: number
      /** Live spill bytes share the host checkpoint cap, so the worker measures this directory. */
      spillDirectory?: string
    }

export type WorkspacePathCheckpointWorkerResult =
  | {
      status: 'restored'
      generationId: string
      publishedScope: 'included' | 'all' | 'both'
      retainedBytes: number
      pathCount: number
      loadMilliseconds: number
      directoryValidationMilliseconds: number
    }
  | { status: 'absent'; reason: string }
  | {
      status: 'written'
      payloadBytes: number
      writeMilliseconds: number
      reusedSpillFile: boolean
    }

export type WorkspacePathIndexBuildWorkerResult = {
  buildId: string
  readyScope: WorkspacePathSearchPathSet
  generationId: string
  retainedBytes: number
  trigramPostingsBytes?: number
  storageMode?: 'packed-folded' | 'disk-spilled'
  spillFileBytes?: number
  complete: boolean
  degradationReason?: string
}

export type WorkspacePathIndexWorkerResponse = {
  id: number
  ok: boolean
  build?: WorkspacePathIndexBuildWorkerResult
  compacted?: { generationId: string; retainedBytes: number }
  reclaimedBytes?: number
  delta?: {
    generationId: string
    retainedBytes: number
    deltaPathCount: number
    deltaBytes: number
    compacted: boolean
  }
  response?: WorkspacePathSearchResponse
  checkpoint?: WorkspacePathCheckpointWorkerResult
  error?: string
  events?: WorkspacePathSearchInstrumentationEvent[]
}
