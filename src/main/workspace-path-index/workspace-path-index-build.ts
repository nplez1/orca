import type { WorkspacePathSearchOwnerIdentity } from '../../shared/workspace-path-search-contract'
import type {
  WorkspacePathSearchCorrelationId,
  WorkspacePathSearchInstrumentationEvent
} from '../../shared/workspace-path-search-instrumentation'
import type {
  WorkspacePathIndexAdmission,
  WorkspacePathIndexReservation
} from './workspace-path-index-admission'
import type { WorkspacePathIndexEntry } from './workspace-path-index-lease'

export type WorkspacePathIndexBuildResult = {
  generationId: string
  retainedBytes: number
  storageMode?: 'packed-folded' | 'disk-spilled'
  spillFileBytes?: number
  degradationReason?: string
}

export type WorkspacePathIndexBuildRequest = {
  key: string
  owner: WorkspacePathSearchOwnerIdentity
  generationId: string
  buildGeneration: number
  eventSequenceFence: number
  firstScope: 'included' | 'all'
  activeWorkspace: boolean
  signal: AbortSignal
  correlationId: WorkspacePathSearchCorrelationId
  onInstrumentation: (event: WorkspacePathSearchInstrumentationEvent) => void
  onScopePublished: (generationId: string, retainedBytes: number, complete: boolean) => void
  /** Drops a worker generation whose retained bytes admission refused. */
  onPublicationRejected?: (generationId: string) => void
}

export function startWorkspacePathIndexBuild(args: {
  entry: WorkspacePathIndexEntry
  request: WorkspacePathIndexBuildRequest
  reservation: WorkspacePathIndexReservation
  admission: WorkspacePathIndexAdmission
  build: (request: WorkspacePathIndexBuildRequest) => Promise<WorkspacePathIndexBuildResult>
  retryBackoffMilliseconds: number
  isCurrent: () => boolean
  recordFailure: () => void
  onPublished: (entry: WorkspacePathIndexEntry) => void
}): void {
  /**
   * Why: an unadmitted generation must never be reachable, so clear the entry's recording, release
   * the root's accounting, back off, and delete every worker copy of the refused bytes.
   */
  const rejectPublication = (reason: string, refusedGenerationId: string): void => {
    const recordedGenerationId = args.entry.generationId
    args.admission.releaseRoot(args.entry.key)
    args.entry.generationId = null
    args.entry.publishedScope = null
    args.entry.retainedBytes = 0
    args.entry.servingLastKnown = false
    args.entry.needsRebuild = true
    setRetry(args.entry, args.retryBackoffMilliseconds, reason)
    for (const generationId of new Set([recordedGenerationId, refusedGenerationId])) {
      if (generationId) {
        args.request.onPublicationRejected?.(generationId)
      }
    }
  }
  const promise = args
    .build(args.request)
    .then((result) => {
      if (args.entry.disposed || !args.isCurrent() || args.request.signal.aborted) {
        args.admission.releaseReservation(args.reservation)
        return { ...result, degradationReason: 'interrupted' }
      }
      if (result.degradationReason) {
        const partialPublished =
          args.entry.generationId !== null &&
          args.entry.retainedBytes > 0 &&
          args.admission.publish(args.reservation, args.entry.retainedBytes)
        if (!partialPublished) {
          rejectPublication(
            result.degradationReason === 'failed' ? 'failed' : 'over-budget',
            result.generationId
          )
        }
        args.entry.freshness =
          result.degradationReason === 'failed'
            ? 'failed'
            : partialPublished
              ? 'no-known-gap'
              : 'provisional'
        args.entry.needsRebuild = result.degradationReason === 'failed' || !partialPublished
        setRetry(args.entry, args.retryBackoffMilliseconds, result.degradationReason)
        args.onPublished(args.entry)
        return result
      }
      if (!args.admission.publish(args.reservation, result.retainedBytes)) {
        rejectPublication('over-budget', result.generationId)
        args.onPublished(args.entry)
        return { ...result, degradationReason: 'over-budget' }
      }
      args.entry.retryAfterAt = 0
      args.entry.lastFailureReason = null
      args.entry.reconciliationRetryCount = 0
      args.entry.freshness = 'no-known-gap'
      args.entry.servingLastKnown = false
      args.entry.needsRebuild = false
      args.entry.generationId = result.generationId
      args.entry.publishedScope = 'both'
      args.entry.retainedBytes = result.retainedBytes
      args.onPublished(args.entry)
      return result
    })
    .catch(() => {
      if (args.entry.disposed || !args.isCurrent() || args.request.signal.aborted) {
        args.admission.releaseReservation(args.reservation)
        return {
          generationId: '',
          retainedBytes: 0,
          degradationReason: 'interrupted'
        }
      }
      const partialPublished =
        args.entry.generationId !== null &&
        args.entry.retainedBytes > 0 &&
        args.admission.publish(args.reservation, args.entry.retainedBytes)
      if (!partialPublished) {
        rejectPublication('failed', args.entry.generationId ?? '')
      }
      args.recordFailure()
      args.entry.freshness = 'failed'
      args.entry.needsRebuild = true
      setRetry(args.entry, args.retryBackoffMilliseconds, 'failed')
      args.onPublished(args.entry)
      return {
        generationId: args.entry.generationId ?? '',
        retainedBytes: args.entry.retainedBytes,
        degradationReason: 'failed'
      }
    })
    .finally(() => {
      if (args.entry.buildPromise === promise) {
        args.entry.buildPromise = null
        args.entry.buildController = null
      }
    })
  args.entry.buildPromise = promise
}

function setRetry(
  entry: WorkspacePathIndexEntry,
  backoffMilliseconds: number,
  reason: string
): void {
  entry.retryAfterAt = Date.now() + backoffMilliseconds
  entry.lastFailureReason = reason
}
