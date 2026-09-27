import { randomUUID } from 'node:crypto'
import type { WorkspacePathSearchOwnerIdentity } from '../../shared/workspace-path-search-contract'
import type { WorkspacePathSearchCorrelationId } from '../../shared/workspace-path-search-instrumentation'
import {
  workspacePathIndexSameOwner,
  type WorkspacePathIndexEntry
} from './workspace-path-index-lease'
import { WorkspacePathIndexServiceReconciliation } from './workspace-path-index-service-reconciliation'
import type { WorkspacePathIndexDeltaMutation } from './workspace-path-index-worker-protocol'

/** Delta application and pending-mutation queueing for the path-index service. */
export abstract class WorkspacePathIndexServiceDelta extends WorkspacePathIndexServiceReconciliation {
  async applyDelta(
    owner: WorkspacePathSearchOwnerIdentity,
    mutations: readonly WorkspacePathIndexDeltaMutation[],
    correlationId: WorkspacePathSearchCorrelationId,
    finishReconciliation = true
  ): Promise<boolean> {
    const entries = [...this.entries.values()].filter(
      (entry) => workspacePathIndexSameOwner(entry.owner, owner) && !entry.disposed
    )
    let accepted = entries.length > 0
    for (const entry of entries) {
      entry.eventSequence += 1
      entry.freshness = 'reconciling'
      this.recordMaintenance(entry, 'event-batch', mutations.length, '')
      if (mutations.length === 0) {
        if (finishReconciliation) {
          entry.activeReconciliations = Math.max(0, entry.activeReconciliations - 1)
          if (entry.activeReconciliations === 0 && !entry.needsRebuild) {
            entry.freshness = 'no-known-gap'
            this.scheduleValidation(entry)
          }
        }
        continue
      }
      if (entry.buildPromise || !entry.generationId) {
        accepted = this.enqueueMutations(entry, mutations, correlationId) && accepted
        continue
      }
      for (let offset = 0; offset < mutations.length; offset += 256) {
        const batch = mutations.slice(offset, offset + 256)
        accepted = (await this.applyEntryDelta(entry, batch, correlationId)) && accepted
        if (!accepted) {
          break
        }
      }
      if (finishReconciliation) {
        entry.activeReconciliations = Math.max(0, entry.activeReconciliations - 1)
      }
      if (accepted) {
        entry.freshness = entry.needsRebuild
          ? 'dirty'
          : entry.activeReconciliations > 0
            ? 'reconciling'
            : 'no-known-gap'
        if (entry.freshness === 'no-known-gap') {
          this.scheduleValidation(entry)
        }
      }
    }
    return accepted
  }

  protected enqueueMutations(
    entry: WorkspacePathIndexEntry,
    mutations: readonly WorkspacePathIndexDeltaMutation[],
    correlationId: WorkspacePathSearchCorrelationId
  ): boolean {
    const incomingBytes = mutations.reduce(
      (sum, mutation) => sum + mutation.path.length * 2 + 48,
      0
    )
    if (
      entry.pendingMutations.length + mutations.length > 1_024 ||
      entry.pendingMutationBytes + incomingBytes > 1024 * 1024
    ) {
      entry.pendingMutations = []
      entry.pendingMutationBytes = 0
      entry.pendingOverflow = true
      entry.activeReconciliations = 0
      entry.freshness = 'dirty'
      entry.needsRebuild = true
      this.clearValidationTimers(entry)
      this.recordMaintenance(entry, 'event-overflow', mutations.length, 'build-event-budget')
      if (!entry.buildPromise) {
        this.scheduleReconciliationRetry(entry)
      }
      return false
    }
    entry.pendingMutations.push(...mutations)
    entry.pendingMutationBytes += incomingBytes
    this.options.onInstrumentation?.({
      kind: 'maintenance',
      record: {
        correlationId,
        action: 'reconciliation-started',
        pathCount: mutations.length,
        byteCount: incomingBytes,
        durationMilliseconds: 0
      }
    })
    return true
  }

  protected async drainPendingMutations(entry: WorkspacePathIndexEntry): Promise<void> {
    if (entry.disposed || entry.pendingMutations.length === 0) {
      if (entry.pendingOverflow) {
        entry.pendingOverflow = false
        entry.activeReconciliations = 0
        entry.freshness = 'dirty'
        entry.needsRebuild = true
        this.scheduleReconciliationRetry(entry)
      }
      return
    }
    if (entry.pendingOverflow) {
      entry.pendingMutations = []
      entry.pendingMutationBytes = 0
      entry.pendingOverflow = false
      entry.activeReconciliations = 0
      entry.freshness = 'dirty'
      entry.needsRebuild = true
      this.scheduleReconciliationRetry(entry)
      return
    }
    const mutations = entry.pendingMutations.splice(0)
    entry.pendingMutationBytes = 0
    for (let offset = 0; offset < mutations.length; offset += 256) {
      const batch = mutations.slice(offset, offset + 256)
      if (!(await this.applyEntryDelta(entry, batch, 'workspace-path-index-event-replay'))) {
        entry.activeReconciliations = 0
        entry.freshness = 'dirty'
        entry.needsRebuild = true
        this.scheduleReconciliationRetry(entry)
        return
      }
    }
    entry.activeReconciliations = 0
    if (!entry.needsRebuild) {
      entry.freshness = 'no-known-gap'
      entry.reconciliationRetryCount = 0
      this.scheduleValidation(entry)
    } else {
      this.scheduleReconciliationRetry(entry)
    }
  }

  protected async applyEntryDelta(
    entry: WorkspacePathIndexEntry,
    mutations: readonly WorkspacePathIndexDeltaMutation[],
    correlationId: WorkspacePathSearchCorrelationId
  ): Promise<boolean> {
    const expectedGenerationId = entry.generationId
    if (!expectedGenerationId || !this.options.applyDelta || entry.disposed) {
      return false
    }
    const startedAt = performance.now()
    entry.freshness = 'reconciling'
    try {
      const result = await this.options.applyDelta({
        key: entry.key,
        expectedGenerationId,
        generationId: `${expectedGenerationId}:delta:${entry.eventSequence}:${randomUUID()}`,
        mutations,
        freshness: 'no-known-gap',
        maxBytes: this.options.maxGenerationBytes ?? 256 * 1024 * 1024,
        correlationId
      })
      if (
        entry.disposed ||
        entry.generationId !== expectedGenerationId ||
        !this.admission.updateRetainedRoot(entry.key, result.retainedBytes)
      ) {
        entry.freshness = 'dirty'
        entry.needsRebuild = true
        return false
      }
      entry.generationId = result.generationId
      entry.retainedBytes = result.retainedBytes
      entry.freshness = entry.needsRebuild
        ? 'dirty'
        : entry.activeReconciliations > 0
          ? 'reconciling'
          : 'no-known-gap'
      if (entry.freshness === 'no-known-gap') {
        this.scheduleValidation(entry)
      }
      if (result.compacted) {
        this.recordMaintenance(
          entry,
          'compaction-triggered',
          result.deltaPathCount,
          'delta-threshold',
          0,
          result.deltaBytes
        )
      }
      this.recordMaintenance(
        entry,
        'delta-applied',
        mutations.length,
        '',
        performance.now() - startedAt,
        result.deltaBytes
      )
      return true
    } catch {
      entry.freshness = 'dirty'
      entry.needsRebuild = true
      entry.retryAfterAt = Date.now() + this.retryBackoffMilliseconds
      return false
    }
  }
}
