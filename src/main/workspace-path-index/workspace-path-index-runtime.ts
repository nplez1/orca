import { app } from 'electron'
import { join } from 'node:path'
import {
  WORKSPACE_PATH_INDEX_BUILD_PEAK_RESERVATION_BYTES,
  WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES
} from '../../shared/__fixtures__/workspace-path-memory-measurement'
import type { WorkspacePathSearchOwnerIdentity } from '../../shared/workspace-path-search-contract'
import type { WorkspacePathIndexDeltaMutation } from './workspace-path-index-worker-protocol'
import { WORKSPACE_PATH_INDEX_BUILD_BOUND_BYTES } from './workspace-path-index-build-budget'
import type {
  WorkspacePathSearchCorrelationId,
  WorkspacePathSearchInstrumentationEvent
} from '../../shared/workspace-path-search-instrumentation'
import type { Store } from '../persistence'
import {
  createDefaultWorkspacePathIndexWorker,
  WorkspacePathIndexWorkerClient
} from './workspace-path-index-worker-client'
import { WorkspacePathIndexService } from './workspace-path-index-service'
import { resolveAuthorizedPath } from '../ipc/filesystem-auth'
import {
  workspacePathIndexFreshnessDeadlineForOwner,
  workspacePathIndexValidationIntervalForOwner
} from './workspace-path-index-owner-cadence'
import { buildWorkspacePathCatalogFromDiscovery } from '../ipc/workspace-path-catalog-builder'
import {
  resolveWorkspacePathFoldLocale,
  workspacePathCatalogFoldCacheKey
} from '../../shared/workspace-path-catalog'
import { isWorkspacePathIndexEnabled } from './workspace-path-index-feature-switch'
import {
  workspacePathCatalogCheckpointDirectory,
  removeWorkspacePathCatalogCheckpoint
} from './workspace-path-catalog-checkpoint-store'
import {
  workspacePathCatalogCheckpointIdentityHash,
  workspacePathCatalogCheckpointIdentityKey
} from './workspace-path-catalog-checkpoint-manifest'
import {
  subscribeLocalPathIndexWatcher,
  unsubscribeLocalPathIndexWatcher
} from '../ipc/filesystem-watcher-local-subscription'

export const WORKSPACE_PATH_INDEX_LISTING_POLICY_VERSION = 'quick-open-scope-v1'

let localService: WorkspacePathIndexService | null = null
let localStore: Store | null = null

/** Creates the local execution-host service; the worker owns each published catalog. */
export function createLocalWorkspacePathIndexService(
  store: Store,
  onInstrumentation?: (event: WorkspacePathSearchInstrumentationEvent) => void
): WorkspacePathIndexService {
  if (localService) {
    return localService
  }
  localStore = store
  let worker: WorkspacePathIndexWorkerClient | null = null
  const getWorker = (): WorkspacePathIndexWorkerClient => {
    worker ??= new WorkspacePathIndexWorkerClient({
      workerFactory: createDefaultWorkspacePathIndexWorker,
      onInstrumentation,
      spillDirectory: join(
        app.getPath('userData'),
        'workspace-path-index-spill',
        String(process.pid)
      )
    })
    return worker
  }
  localService = new WorkspacePathIndexService({
    authorize: (owner) => authorizeWorkspacePathRoot(owner, store),
    peakBuildReservationBytes: WORKSPACE_PATH_INDEX_BUILD_PEAK_RESERVATION_BYTES,
    reclaimOptionalStructures: (key, generationId) =>
      worker?.discardOptionalStructures(key, generationId) ?? Promise.resolve(0),
    spillResidentCatalog: (key, generationId) =>
      worker?.spillResidentCatalog(key, generationId) ?? Promise.resolve(0),
    restoreCheckpoint: async ({ owner, entryKey }) => {
      if (!isWorkspacePathIndexEnabled()) {
        return null
      }
      const outcome = await getWorker().restoreCheckpoint({
        key: entryKey,
        checkpointDirectory: checkpointDirectoryFor(owner)
      })
      return outcome.status === 'restored'
        ? {
            generationId: outcome.generationId,
            publishedScope: outcome.publishedScope,
            retainedBytes: outcome.retainedBytes,
            loadMilliseconds: outcome.loadMilliseconds
          }
        : null
    },
    writeCheckpoint: ({ owner, entryKey, generationId, maxBytes }) => {
      if (!isWorkspacePathIndexEnabled()) {
        return
      }
      // Fire and forget: checkpointing must never sit on the interactive path.
      void getWorker()
        .writeCheckpoint({
          key: entryKey,
          generationId,
          checkpointDirectory: checkpointDirectoryFor(owner),
          maxBytes
        })
        .catch(() => undefined)
    },
    deleteCheckpoint: (owner) => {
      void removeWorkspacePathCatalogCheckpoint(checkpointDirectoryFor(owner)).catch(
        () => undefined
      )
    },
    beforeBuild: (owner) => subscribeLocalPathIndexWatcher(owner.authorizedCanonicalRoot),
    validationIntervalForOwner: (owner) => workspacePathIndexValidationIntervalForOwner(owner),
    freshnessDeadlineForOwner: (owner) => workspacePathIndexFreshnessDeadlineForOwner(owner),
    build: async (request) => {
      if (process.env.VITEST) {
        return {
          generationId: request.generationId,
          retainedBytes: 0,
          degradationReason: 'failed'
        }
      }
      const workerClient = getWorker()
      const buildId = `${request.generationId}:${request.buildGeneration}`
      const built = await buildWorkspacePathCatalogFromDiscovery(
        request.owner.authorizedCanonicalRoot,
        store,
        {
          firstScope: request.firstScope,
          generationId: request.generationId,
          overlayGenerationId: `${request.generationId}:overlay`,
          maxBytes: WORKSPACE_PATH_INDEX_BUILD_BOUND_BYTES,
          freshness: 'no-known-gap',
          signal: request.signal,
          correlationId: request.correlationId,
          onInstrumentation: request.onInstrumentation,
          workerBuild: {
            begin: () =>
              workerClient.beginCatalogBuild({
                key: request.key,
                buildId,
                generationId: request.generationId,
                firstScope: request.firstScope,
                maxBytes: WORKSPACE_PATH_INDEX_BUILD_BOUND_BYTES,
                correlationId: request.correlationId
              }),
            addBatch: (pathSet, paths) =>
              workerClient.appendCatalogPathBatch(buildId, pathSet, paths),
            finishScope: (pathSet) => workerClient.finishCatalogScope(buildId, pathSet),
            abort: (preservePublished) => workerClient.abortCatalogBuild(buildId, preservePublished)
          },
          onWorkerScopePublished: (scope) =>
            request.onScopePublished(scope.generationId, scope.retainedBytes, scope.complete)
        }
      )
      return {
        generationId: built.workerGenerationId ?? request.generationId,
        retainedBytes: built.workerRetainedBytes ?? 0,
        ...(built.workerStorageMode ? { storageMode: built.workerStorageMode } : {}),
        ...(built.workerSpillFileBytes === undefined
          ? {}
          : { spillFileBytes: built.workerSpillFileBytes }),
        ...(built.degradationReason ? { degradationReason: built.degradationReason } : {})
      }
    },
    query: (request) => getWorker().query(request.key, request.identity, request.correlationId),
    applyDelta: (request) => getWorker().applyDelta(request),
    maxGenerationBytes: WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES,
    cancelQuery: (consumerKey) => worker?.cancel(consumerKey),
    onInstrumentation,
    disposeGeneration: (key) => {
      void worker?.drop(key).catch(() => undefined)
    },
    dropRejectedGeneration: (key, generationId) => {
      void worker?.drop(key, generationId).catch(() => undefined)
    },
    onDisposeOwner: (owner) => unsubscribeLocalPathIndexWatcher(owner.authorizedCanonicalRoot),
    shutdownWorker: () => worker?.dispose()
  })
  return localService
}

export function hasLocalWorkspacePathIndexService(): boolean {
  return localService !== null
}

export function hasLocalWorkspacePathIndex(rootPath: string): boolean {
  return localService?.hasIndex(localWorkspaceOwner(rootPath)) ?? false
}

export function getLocalWorkspacePathIndexStore(): Store | null {
  return localStore
}

export function releaseLocalWorkspacePathIndexLease(leaseId: string): void {
  localService?.releaseLease(leaseId)
}

export function beginLocalWorkspacePathIndexReconciliation(
  rootPath: string,
  eventCount: number
): void {
  localService?.beginReconciliation(localWorkspaceOwner(rootPath), eventCount)
}

export async function applyLocalWorkspacePathIndexDelta(
  rootPath: string,
  mutations: readonly WorkspacePathIndexDeltaMutation[],
  correlationId: WorkspacePathSearchCorrelationId,
  finishReconciliation: boolean
): Promise<boolean> {
  if (!localService) {
    return false
  }
  return localService.applyDelta(
    localWorkspaceOwner(rootPath),
    mutations,
    correlationId,
    finishReconciliation
  )
}

export function completeLocalWorkspacePathIndexReconciliation(rootPath: string): void {
  localService?.completeReconciliation(localWorkspaceOwner(rootPath))
}

export function failLocalWorkspacePathIndexReconciliation(rootPath: string, reason: string): void {
  localService?.failReconciliation(localWorkspaceOwner(rootPath), reason)
}

export function invalidateLocalWorkspacePathIndex(
  rootPath: string,
  reason?: string,
  eventCount?: number
): void {
  localService?.invalidate(localWorkspaceOwner(rootPath), reason, eventCount)
}

export function evictLocalWorkspacePathIndex(rootPath: string): void {
  localService?.revoke(localWorkspaceOwner(rootPath))
}

export function clearLocalWorkspacePathIndex(): void {
  localService?.dispose()
  localService = null
  localStore = null
}

function localWorkspaceOwner(rootPath: string): WorkspacePathSearchOwnerIdentity {
  return {
    executionHost: { provider: 'local', incarnationId: String(process.pid) },
    authorizedCanonicalRoot: rootPath
  }
}

/**
 * Checkpoints live outside the workspace, keyed by a restart-stable identity. The worker re-checks
 * the folding and scope-rule versions it resolved for itself before trusting any of this.
 */
function checkpointDirectoryFor(owner: WorkspacePathSearchOwnerIdentity): string {
  return workspacePathCatalogCheckpointDirectory(
    join(app.getPath('userData'), 'workspace-path-checkpoints'),
    workspacePathCatalogCheckpointIdentityHash(
      workspacePathCatalogCheckpointIdentityKey({
        owner,
        listingPolicyVersion: WORKSPACE_PATH_INDEX_LISTING_POLICY_VERSION,
        foldVersion: workspacePathCatalogFoldCacheKey(),
        foldLocale: resolveWorkspacePathFoldLocale()
      })
    )
  )
}

async function authorizeWorkspacePathRoot(
  owner: WorkspacePathSearchOwnerIdentity,
  store: Store
): Promise<string | null> {
  try {
    return await resolveAuthorizedPath(owner.authorizedCanonicalRoot, store)
  } catch {
    return null
  }
}
