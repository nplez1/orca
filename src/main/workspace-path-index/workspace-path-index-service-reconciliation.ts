import type { WorkspacePathSearchOwnerIdentity } from '../../shared/workspace-path-search-contract'
import {
  workspacePathIndexSameOwner,
  type WorkspacePathIndexEntry
} from './workspace-path-index-lease'
import { WorkspacePathIndexServiceSearch } from './workspace-path-index-service-search'

/** Invalidation, reconciliation accounting, and validation timers for the path-index service. */
export abstract class WorkspacePathIndexServiceReconciliation extends WorkspacePathIndexServiceSearch {
  invalidate(owner: WorkspacePathSearchOwnerIdentity, reason = 'event-gap', eventCount = 0): void {
    for (const entry of this.entries.values()) {
      if (workspacePathIndexSameOwner(entry.owner, owner)) {
        entry.eventSequence += 1
        entry.continuityEpoch += 1
        entry.activeReconciliations = 0
        this.clearValidationTimers(entry)
        entry.freshness = 'dirty'
        entry.needsRebuild = true
        entry.retryAfterAt = 0
        entry.lastFailureReason = null
        if (entry.buildPromise) {
          entry.pendingMutations = []
          entry.pendingMutationBytes = 0
          entry.pendingOverflow = true
        }
        const overflow =
          reason === 'watcher-overflow' ||
          reason === 'watcher-interruption' ||
          reason === 'watcher-error'
        this.recordMaintenance(
          entry,
          overflow ? 'event-overflow' : 'freshness-downgrade',
          eventCount,
          reason
        )
        if (!entry.buildPromise) {
          this.scheduleReconciliationRetry(entry)
        }
      }
    }
  }

  beginReconciliation(owner: WorkspacePathSearchOwnerIdentity, eventCount: number): void {
    for (const entry of this.entries.values()) {
      if (workspacePathIndexSameOwner(entry.owner, owner) && !entry.disposed) {
        entry.eventSequence += 1
        entry.activeReconciliations += 1
        entry.freshness = 'reconciling'
        this.recordMaintenance(entry, 'event-batch', eventCount, 'reconciliation-started')
      }
    }
  }

  failReconciliation(owner: WorkspacePathSearchOwnerIdentity, reason: string): void {
    for (const entry of this.entries.values()) {
      if (workspacePathIndexSameOwner(entry.owner, owner) && !entry.disposed) {
        entry.continuityEpoch += 1
        entry.activeReconciliations = Math.max(0, entry.activeReconciliations - 1)
        this.clearValidationTimers(entry)
        entry.freshness = 'dirty'
        entry.needsRebuild = true
        this.recordMaintenance(entry, 'freshness-downgrade', 0, reason)
        this.scheduleReconciliationRetry(entry)
      }
    }
  }

  completeReconciliation(owner: WorkspacePathSearchOwnerIdentity): void {
    for (const entry of this.entries.values()) {
      if (workspacePathIndexSameOwner(entry.owner, owner) && !entry.disposed) {
        entry.activeReconciliations = Math.max(0, entry.activeReconciliations - 1)
        if (entry.activeReconciliations === 0 && !entry.needsRebuild) {
          entry.freshness = 'no-known-gap'
          this.scheduleValidation(entry)
        }
      }
    }
  }

  protected scheduleReconciliationRetry(entry: WorkspacePathIndexEntry): void {
    this.clearValidationTimers(entry)
    if (entry.disposed || !entry.needsRebuild || !entry.validationRequest) {
      return
    }
    const retryDelay = Math.min(
      30_000,
      this.retryBackoffMilliseconds * 2 ** entry.reconciliationRetryCount
    )
    entry.reconciliationRetryCount += 1
    entry.validationTimer = setTimeout(
      () => {
        entry.validationTimer = null
        if (entry.disposed || !entry.validationRequest || !entry.needsRebuild) {
          return
        }
        entry.freshness = 'reconciling'
        entry.freshnessDeadlineTimer = setTimeout(() => {
          entry.freshnessDeadlineTimer = null
          if (!entry.disposed && entry.needsRebuild) {
            entry.freshness = 'dirty'
            this.recordMaintenance(entry, 'freshness-downgrade', 0, 'freshness-deadline')
          }
        }, this.freshnessDeadlineFor(entry.owner))
        entry.freshnessDeadlineTimer.unref?.()
        void this.ensureCoordinator.ensure({
          owner: entry.owner,
          ...entry.validationRequest,
          correlationId: 'workspace-path-reconciliation-retry'
        })
      },
      Math.max(50, retryDelay)
    )
    entry.validationTimer.unref?.()
  }

  protected scheduleValidation(entry: WorkspacePathIndexEntry): void {
    this.clearValidationTimers(entry)
    if (
      entry.disposed ||
      entry.needsRebuild ||
      entry.freshness !== 'no-known-gap' ||
      !entry.validationRequest ||
      this.validationIntervalFor(entry.owner) <= 0
    ) {
      return
    }
    entry.validationTimer = setTimeout(() => {
      entry.validationTimer = null
      if (entry.disposed || !entry.validationRequest) {
        return
      }
      entry.freshness = 'reconciling'
      entry.needsRebuild = true
      this.recordMaintenance(entry, 'reconciliation-started', 0, 'scheduled-validation')
      entry.freshnessDeadlineTimer = setTimeout(() => {
        entry.freshnessDeadlineTimer = null
        if (entry.disposed || !entry.needsRebuild) {
          return
        }
        entry.freshness = 'dirty'
        this.recordMaintenance(entry, 'freshness-downgrade', 0, 'freshness-deadline')
      }, this.freshnessDeadlineFor(entry.owner))
      entry.freshnessDeadlineTimer.unref?.()
      void this.ensureCoordinator.ensure({
        owner: entry.owner,
        ...entry.validationRequest,
        correlationId: 'workspace-path-scheduled-validation'
      })
    }, this.validationIntervalFor(entry.owner))
    entry.validationTimer.unref?.()
  }
}
