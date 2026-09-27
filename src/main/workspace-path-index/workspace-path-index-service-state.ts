import type { WorkspacePathSearchOwnerIdentity } from '../../shared/workspace-path-search-contract'
import { WorkspacePathIndexAdmission } from './workspace-path-index-admission'
import { WorkspacePathIndexBuildLane } from './workspace-path-index-build-lane'
import { loadAdoptableWorkspacePathCheckpoint } from './workspace-path-index-checkpoint-adoption'
import { WorkspacePathIndexEnsure } from './workspace-path-index-ensure'
import {
  workspacePathIndexSameOwner,
  type WorkspacePathIndexEntry
} from './workspace-path-index-lease'
import { WorkspacePathIndexRetention } from './workspace-path-index-retention'
import { WorkspacePathIndexSearch } from './workspace-path-index-search'
import type { WorkspacePathIndexServiceOptions } from './workspace-path-index-service-options'

/** Shared state, admission wiring, and maintenance instrumentation for the path-index service. */
export abstract class WorkspacePathIndexServiceState {
  protected readonly entries = new Map<string, WorkspacePathIndexEntry>()
  protected readonly leases = new Map<string, { key: string; entry: WorkspacePathIndexEntry }>()
  protected readonly admission: WorkspacePathIndexAdmission
  protected readonly buildLane = new WorkspacePathIndexBuildLane()
  protected readonly ensureCoordinator: WorkspacePathIndexEnsure
  protected readonly searcher: WorkspacePathIndexSearch
  protected readonly retention: WorkspacePathIndexRetention
  protected readonly retryBackoffMilliseconds: number
  protected readonly validationIntervalMilliseconds: number
  protected readonly freshnessDeadlineMilliseconds: number
  protected disposed = false

  constructor(protected readonly options: WorkspacePathIndexServiceOptions) {
    this.admission = options.admission ?? new WorkspacePathIndexAdmission()
    this.retryBackoffMilliseconds = options.retryBackoffMilliseconds ?? 5_000
    this.validationIntervalMilliseconds = options.validationIntervalMilliseconds ?? 5 * 60_000
    this.freshnessDeadlineMilliseconds = options.freshnessDeadlineMilliseconds ?? 15 * 60_000
    this.retention = new WorkspacePathIndexRetention(
      this.entries,
      options.maxRetainedRoots ?? 8,
      options.retentionMilliseconds ?? 5 * 60_000,
      (entry) => this.disposeEntry(entry)
    )
    this.ensureCoordinator = new WorkspacePathIndexEnsure({
      entries: this.entries,
      admission: this.admission,
      peakBuildReservationBytes: options.peakBuildReservationBytes,
      buildLane: this.buildLane,
      authorize: options.authorize,
      build: options.build,
      reclaimOptionalStructures: options.reclaimOptionalStructures,
      spillResidentCatalog: options.spillResidentCatalog,
      restoreCheckpoint: (args) =>
        loadAdoptableWorkspacePathCheckpoint({
          restore: options.restoreCheckpoint,
          admit: (entryKey, retainedBytes) =>
            this.admission.updateRetainedRoot(entryKey, retainedBytes),
          owner: args.owner,
          entryKey: args.entryKey
        }),
      onRevokeOwner: (owner) => options.deleteCheckpoint?.(owner),
      beforeBuild: options.beforeBuild,
      retryBackoffMilliseconds: this.retryBackoffMilliseconds,
      onInstrumentation: options.onInstrumentation,
      onGenerationChange: (key) => this.searcher.cancelEntry(key),
      dropRejectedGeneration: options.dropRejectedGeneration,
      disposeEntry: (entry) => this.disposeEntry(entry),
      onPublished: (entry) => {
        this.retention.enforceLimit()
        if (entry.activeReconciliations > 0) {
          entry.freshness = 'reconciling'
        }
        // Only a complete snapshot is a checkpoint unit; a single-scope or delta generation is not.
        if (entry.generationId && entry.publishedScope === 'both') {
          this.options.writeCheckpoint?.({
            owner: entry.owner,
            entryKey: entry.key,
            generationId: entry.generationId,
            maxBytes: this.options.maxGenerationBytes ?? entry.retainedBytes
          })
        }
        void this.drainPendingMutations(entry).then(() => {
          if (entry.activeReconciliations === 0 && entry.freshness === 'no-known-gap') {
            entry.reconciliationRetryCount = 0
            this.scheduleValidation(entry)
          } else if (entry.needsRebuild && !entry.buildPromise) {
            this.scheduleReconciliationRetry(entry)
          }
        })
      }
    })
    this.searcher = new WorkspacePathIndexSearch({
      query: options.query,
      cancelQuery: options.cancelQuery,
      maxPendingConsumers: options.maxPendingConsumers ?? 64,
      onWorkerFailure: (consumerKey) => this.onWorkerFailure(consumerKey)
    })
  }

  protected abstract scheduleValidation(entry: WorkspacePathIndexEntry): void
  protected abstract scheduleReconciliationRetry(entry: WorkspacePathIndexEntry): void
  protected abstract drainPendingMutations(entry: WorkspacePathIndexEntry): Promise<void>
  protected abstract onWorkerFailure(consumerKey: string): void

  protected validationIntervalFor(owner: WorkspacePathSearchOwnerIdentity): number {
    return Math.max(
      1,
      this.options.validationIntervalForOwner?.(owner) ?? this.validationIntervalMilliseconds
    )
  }

  protected freshnessDeadlineFor(owner: WorkspacePathSearchOwnerIdentity): number {
    return Math.max(
      1,
      this.options.freshnessDeadlineForOwner?.(owner) ?? this.freshnessDeadlineMilliseconds
    )
  }

  protected clearValidationTimers(entry: WorkspacePathIndexEntry): void {
    if (entry.validationTimer) {
      clearTimeout(entry.validationTimer)
      entry.validationTimer = null
    }
    if (entry.freshnessDeadlineTimer) {
      clearTimeout(entry.freshnessDeadlineTimer)
      entry.freshnessDeadlineTimer = null
    }
  }

  protected recordMaintenance(
    entry: WorkspacePathIndexEntry,
    action:
      | 'reconciliation-started'
      | 'event-batch'
      | 'event-overflow'
      | 'freshness-downgrade'
      | 'delta-applied'
      | 'compaction-triggered',
    pathCount: number,
    reason: string,
    durationMilliseconds = 0,
    byteCount = entry.pendingMutationBytes
  ): void {
    this.options.onInstrumentation?.({
      kind: 'maintenance',
      record: {
        correlationId: 'workspace-path-index-maintenance',
        action,
        pathCount,
        byteCount,
        durationMilliseconds,
        ...(reason ? { reason } : {})
      }
    })
  }

  protected disposeOwner(owner: WorkspacePathSearchOwnerIdentity): void {
    for (const entry of this.entries.values()) {
      if (workspacePathIndexSameOwner(entry.owner, owner)) {
        this.disposeEntry(entry)
      }
    }
  }
  protected disposeEntry(entry: WorkspacePathIndexEntry): void {
    entry.disposed = true
    this.clearValidationTimers(entry)
    entry.buildGeneration += 1
    if (entry.generationId) {
      this.options.disposeGeneration?.(entry.key)
    }
    entry.buildController?.abort()
    entry.buildController = null
    entry.buildPromise = null
    this.searcher.cancelEntry(entry.key)
    for (const leaseId of entry.leases) {
      this.leases.delete(leaseId)
    }
    entry.leases.clear()
    if (this.entries.get(entry.key) === entry) {
      this.entries.delete(entry.key)
    }
    this.admission.releaseRoot(entry.key)
    if (
      ![...this.entries.values()].some((candidate) =>
        workspacePathIndexSameOwner(candidate.owner, entry.owner)
      )
    ) {
      this.options.onDisposeOwner?.(entry.owner)
    }
  }
}
