import { randomUUID } from 'node:crypto'
import type {
  WorkspacePathSearchFenceIdentity,
  WorkspacePathSearchOwnerIdentity,
  WorkspacePathSearchPathSet
} from '../../shared/workspace-path-search-contract'
import type { WorkspacePathSearchCorrelationId } from '../../shared/workspace-path-search-instrumentation'
import type {
  WorkspacePathIndexEnsureArgs,
  WorkspacePathIndexEnsureResult
} from './workspace-path-index-ensure'
import { withWorkspacePathSearchFreshness } from './workspace-path-index-freshness'
import { workspacePathIndexSameOwner } from './workspace-path-index-lease'
import { WorkspacePathIndexServiceState } from './workspace-path-index-service-state'
import type { WorkspacePathIndexSearchResult } from './workspace-path-index-service-options'

/** Lease acquisition and search entry points for the path-index service. */
export abstract class WorkspacePathIndexServiceSearch extends WorkspacePathIndexServiceState {
  async acquireLease(args: {
    owner: WorkspacePathSearchOwnerIdentity
    listingPolicyVersion: string
    foldVersion: string
    buildReservationBytes: number
    firstScope?: WorkspacePathSearchPathSet
    activeWorkspace?: boolean
    correlationId: WorkspacePathSearchCorrelationId
  }): Promise<string | null> {
    const ensured = await this.ensure({
      ...args,
      activeWorkspace: args.activeWorkspace ?? true
    })
    if (!ensured.key) {
      return null
    }
    const entry = this.entries.get(ensured.key)
    if (!entry || entry.disposed) {
      return null
    }
    const leaseId = randomUUID()
    entry.leases.add(leaseId)
    entry.lastUsedAt = Date.now()
    this.leases.set(leaseId, { key: entry.key, entry })
    return leaseId
  }

  releaseLease(leaseId: string): void {
    const lease = this.leases.get(leaseId)
    if (!lease) {
      return
    }
    this.leases.delete(leaseId)
    lease.entry.leases.delete(leaseId)
    lease.entry.lastUsedAt = Date.now()
    this.retention.afterRelease()
  }

  async ensure(args: WorkspacePathIndexEnsureArgs): Promise<WorkspacePathIndexEnsureResult> {
    if (this.disposed) {
      return { ready: false, key: null, reason: 'failed' }
    }
    const result = await this.ensureCoordinator.ensure(args)
    const entry = result.key ? this.entries.get(result.key) : undefined
    if (entry) {
      entry.validationRequest = {
        listingPolicyVersion: args.listingPolicyVersion,
        foldVersion: args.foldVersion,
        buildReservationBytes: args.buildReservationBytes,
        firstScope: args.firstScope ?? 'included',
        activeWorkspace: args.activeWorkspace ?? false,
        correlationId: args.correlationId
      }
      if (result.ready) {
        this.scheduleValidation(entry)
      }
    }
    return result
  }

  async search(args: {
    identity: WorkspacePathSearchFenceIdentity
    listingPolicyVersion: string
    foldVersion: string
    buildReservationBytes: number
    correlationId: WorkspacePathSearchCorrelationId
  }): Promise<WorkspacePathIndexSearchResult> {
    const ensureStartedAt = performance.now()
    const ensured = await this.ensure({
      owner: args.identity.owner,
      listingPolicyVersion: args.listingPolicyVersion,
      foldVersion: args.foldVersion,
      buildReservationBytes: args.buildReservationBytes,
      firstScope: args.identity.scope.pathSet,
      activeWorkspace: true,
      correlationId: args.correlationId
    })
    this.emitSearchStage(args.correlationId, 'service-ensure', performance.now() - ensureStartedAt)
    const entry = ensured.key ? this.entries.get(ensured.key) : undefined
    const owner = ensured.ready ? ensured.owner : entry?.owner
    if (!entry?.generationId || !ensured.key || !owner) {
      return {
        ready: false,
        reason: ensured.ready ? 'failed' : ensured.reason
      }
    }
    if (
      !ensured.ready &&
      (entry.freshness === 'no-known-gap' || entry.freshness === 'provisional')
    ) {
      return { ready: false, reason: ensured.reason }
    }
    const queryStartedAt = performance.now()
    const result = await this.searcher.search({
      key: ensured.key,
      identity: {
        ...args.identity,
        owner,
        generationId: entry.generationId
      },
      correlationId: args.correlationId
    })
    this.emitSearchStage(
      args.correlationId,
      'service-query-total',
      performance.now() - queryStartedAt
    )
    if (!result.ready) {
      return result
    }
    return {
      ready: true,
      response: withWorkspacePathSearchFreshness(result.response, entry.freshness)
    }
  }

  protected emitSearchStage(
    correlationId: WorkspacePathSearchCorrelationId,
    stage: 'service-ensure' | 'service-query-total',
    milliseconds: number
  ): void {
    this.options.onInstrumentation?.({
      kind: 'stage-timing',
      record: {
        correlationId,
        stage,
        duration: { milliseconds, clock: 'execution-host-monotonic' }
      }
    })
  }

  recordDegradation(correlationId: WorkspacePathSearchCorrelationId, reason: string): void {
    this.options.onInstrumentation?.({
      kind: 'degradation',
      correlationId,
      reason
    })
  }

  hasIndex(owner: WorkspacePathSearchOwnerIdentity): boolean {
    return [...this.entries.values()].some(
      (entry) => !entry.disposed && workspacePathIndexSameOwner(entry.owner, owner)
    )
  }

  cancelLocalConsumer(consumerId: string): void {
    this.searcher.cancelLocalConsumer(consumerId)
  }

  revoke(owner: WorkspacePathSearchOwnerIdentity): void {
    this.disposeOwner(owner)
    this.options.deleteCheckpoint?.(owner)
  }

  protected onWorkerFailure(_consumerKey: string): void {
    const retryAfter = Date.now() + this.retryBackoffMilliseconds
    for (const entry of this.entries.values()) {
      this.searcher.cancelEntry(entry.key)
      this.clearValidationTimers(entry)
      entry.continuityEpoch += 1
      entry.freshness = 'failed'
      entry.needsRebuild = true
      entry.activeReconciliations = 0
      entry.buildGeneration += 1
      entry.buildController?.abort()
      entry.generationId = null
      entry.publishedScope = null
      entry.retainedBytes = 0
      entry.servingLastKnown = false
      entry.retryAfterAt = retryAfter
      entry.lastFailureReason = 'failed'
      this.admission.releaseRoot(entry.key)
    }
  }
}
