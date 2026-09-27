import type {
  WorkspacePathSearchFreshness,
  WorkspacePathSearchOwnerIdentity,
  WorkspacePathSearchResponse
} from '../../shared/workspace-path-search-contract'
import type {
  WorkspacePathSearchCorrelationId,
  WorkspacePathSearchInstrumentationEvent
} from '../../shared/workspace-path-search-instrumentation'
import type { WorkspacePathIndexAdmission } from './workspace-path-index-admission'
import type {
  WorkspacePathIndexBuildRequest,
  WorkspacePathIndexBuildResult
} from './workspace-path-index-build'
import type { WorkspacePathIndexCheckpointRestore } from './workspace-path-index-checkpoint-adoption'
import type { WorkspacePathIndexQueryRequest } from './workspace-path-index-search'
import type { WorkspacePathIndexDeltaMutation } from './workspace-path-index-worker-protocol'

export type WorkspacePathIndexWorkerQuery = WorkspacePathIndexQueryRequest

export type WorkspacePathIndexServiceOptions = {
  authorize: (owner: WorkspacePathSearchOwnerIdentity) => Promise<string | null>
  beforeBuild?: (owner: WorkspacePathSearchOwnerIdentity) => Promise<boolean>
  build: (request: WorkspacePathIndexBuildRequest) => Promise<WorkspacePathIndexBuildResult>
  reclaimOptionalStructures?: (key: string, generationId: string) => Promise<number>
  spillResidentCatalog?: (key: string, generationId: string) => Promise<number>
  /**
   * Loads a host-local checkpoint for a cold root. A checkpoint is best effort: absence, corruption,
   * or a budget refusal always falls back to the live build, never to wrong results.
   */
  restoreCheckpoint?: (args: {
    owner: WorkspacePathSearchOwnerIdentity
    entryKey: string
  }) => Promise<WorkspacePathIndexCheckpointRestore | null>
  /** Persists a completed generation off the interactive path; failures are ignored. */
  writeCheckpoint?: (args: {
    owner: WorkspacePathSearchOwnerIdentity
    entryKey: string
    generationId: string
    maxBytes: number
  }) => void
  /** Deletes a root's checkpoint when its authorization is revoked. */
  deleteCheckpoint?: (owner: WorkspacePathSearchOwnerIdentity) => void
  query: (request: WorkspacePathIndexWorkerQuery) => Promise<WorkspacePathSearchResponse>
  applyDelta?: (request: {
    key: string
    expectedGenerationId: string
    generationId: string
    mutations: readonly WorkspacePathIndexDeltaMutation[]
    freshness: WorkspacePathSearchFreshness
    maxBytes: number
    correlationId: WorkspacePathSearchCorrelationId
  }) => Promise<{
    generationId: string
    retainedBytes: number
    deltaPathCount: number
    deltaBytes: number
    compacted: boolean
  }>
  maxGenerationBytes?: number
  validationIntervalMilliseconds?: number
  validationIntervalForOwner?: (owner: WorkspacePathSearchOwnerIdentity) => number
  freshnessDeadlineMilliseconds?: number
  freshnessDeadlineForOwner?: (owner: WorkspacePathSearchOwnerIdentity) => number
  cancelQuery?: (consumerKey: string) => void
  onInstrumentation?: (event: WorkspacePathSearchInstrumentationEvent) => void
  admission?: WorkspacePathIndexAdmission
  peakBuildReservationBytes?: number
  maxPendingConsumers?: number
  retentionMilliseconds?: number
  retryBackoffMilliseconds?: number
  maxRetainedRoots?: number
  disposeGeneration?: (key: string) => void
  /** Deletes a single worker generation the host refused to admit, leaving the root's others intact. */
  dropRejectedGeneration?: (key: string, generationId: string) => void
  onDisposeOwner?: (owner: WorkspacePathSearchOwnerIdentity) => void
  shutdownWorker?: () => void
}

export type WorkspacePathIndexSearchResult =
  | { ready: true; response: WorkspacePathSearchResponse }
  | { ready: false; reason: string }
