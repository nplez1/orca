import { randomUUID } from 'node:crypto'
import type {
  WorkspacePathSearchOwnerIdentity,
  WorkspacePathSearchPathSet
} from '../../shared/workspace-path-search-contract'
import type {
  WorkspacePathSearchCorrelationId,
  WorkspacePathSearchInstrumentationEvent
} from '../../shared/workspace-path-search-instrumentation'
import type { WorkspacePathIndexAdmission } from './workspace-path-index-admission'
import { relieveWorkspacePathIndexAdmission } from './workspace-path-index-admission-relief'
import type { WorkspacePathIndexBuildLane } from './workspace-path-index-build-lane'
import {
  startWorkspacePathIndexBuild,
  type WorkspacePathIndexBuildRequest,
  type WorkspacePathIndexBuildResult
} from './workspace-path-index-build'
import {
  adoptWorkspacePathCheckpoint,
  type WorkspacePathIndexCheckpointRestore
} from './workspace-path-index-checkpoint-adoption'
import {
  createWorkspacePathIndexEntry,
  workspacePathIndexOwnershipKey,
  workspacePathIndexSameOwner,
  type WorkspacePathIndexEntry
} from './workspace-path-index-lease'

export type WorkspacePathIndexEnsureResult =
  | {
      ready: true
      key: string
      generationId: string
      owner: WorkspacePathSearchOwnerIdentity
    }
  | { ready: false; key: string | null; reason: string }

export type WorkspacePathIndexEnsureArgs = {
  owner: WorkspacePathSearchOwnerIdentity
  listingPolicyVersion: string
  foldVersion: string
  buildReservationBytes: number
  firstScope?: WorkspacePathSearchPathSet
  activeWorkspace?: boolean
  correlationId: WorkspacePathSearchCorrelationId
}

/** Coordinates authorization, reservations, build generation fencing, and publication. */
export class WorkspacePathIndexEnsure {
  constructor(
    private readonly dependencies: {
      entries: Map<string, WorkspacePathIndexEntry>
      admission: WorkspacePathIndexAdmission
      peakBuildReservationBytes?: number
      buildLane: WorkspacePathIndexBuildLane
      authorize: (owner: WorkspacePathSearchOwnerIdentity) => Promise<string | null>
      build: (request: WorkspacePathIndexBuildRequest) => Promise<WorkspacePathIndexBuildResult>
      reclaimOptionalStructures?: (key: string, generationId: string) => Promise<number>
      spillResidentCatalog?: (key: string, generationId: string) => Promise<number>
      beforeBuild?: (owner: WorkspacePathSearchOwnerIdentity) => Promise<boolean>
      retryBackoffMilliseconds: number
      onInstrumentation?: (event: WorkspacePathSearchInstrumentationEvent) => void
      onGenerationChange: (key: string) => void
      disposeEntry: (entry: WorkspacePathIndexEntry) => void
      onPublished: (entry: WorkspacePathIndexEntry) => void
      /** Removes a worker generation the host refused to admit; must not disturb other generations. */
      dropRejectedGeneration?: (key: string, generationId: string) => void
      restoreCheckpoint?: (args: {
        owner: WorkspacePathSearchOwnerIdentity
        entryKey: string
      }) => Promise<WorkspacePathIndexCheckpointRestore | null>
      onRevokeOwner?: (owner: WorkspacePathSearchOwnerIdentity) => void
    }
  ) {}

  async ensure(args: WorkspacePathIndexEnsureArgs): Promise<WorkspacePathIndexEnsureResult> {
    const canonicalRoot = await this.dependencies.authorize(args.owner)
    if (!canonicalRoot) {
      this.disposeOwner(args.owner)
      return { ready: false, key: null, reason: 'authorization-revoked' }
    }
    const owner = { ...args.owner, authorizedCanonicalRoot: canonicalRoot }
    const key = workspacePathIndexOwnershipKey(owner, args.listingPolicyVersion, args.foldVersion)
    let entry = this.dependencies.entries.get(key)
    if (!entry) {
      entry = createWorkspacePathIndexEntry(key, owner)
      this.dependencies.entries.set(key, entry)
      const restore = this.dependencies.restoreCheckpoint
      if (restore) {
        await adoptWorkspacePathCheckpoint(entry, restore)
      }
    }
    entry.lastUsedAt = Date.now()
    const requiredScope = args.firstScope ?? 'included'
    const scopeCovered = entry.publishedScope === 'both' || entry.publishedScope === requiredScope
    if (entry.generationId && !entry.needsRebuild && scopeCovered) {
      return { ready: true, key, generationId: entry.generationId, owner }
    }
    /**
     * While reconciliation runs, a restored root keeps answering from its last-known generation and
     * the contract labels every reply provisional. Once the checkpoint is dropped the answer is a
     * plain "building" so no query can address a generation that no longer exists.
     */
    const notReady = (reason: string): WorkspacePathIndexEnsureResult => {
      const provisionalGenerationId = entry.servingLastKnown ? entry.generationId : null
      return scopeCovered && provisionalGenerationId !== null
        ? { ready: true, key, generationId: provisionalGenerationId, owner }
        : { ready: false, key, reason }
    }
    if (entry.buildPromise) {
      this.recordMiss(args.correlationId, 'building')
      return notReady('building')
    }
    if (entry.retryAfterAt > Date.now()) {
      const reason = entry.lastFailureReason ?? 'failed'
      if (reason === 'failed' || reason === 'over-budget') {
        this.recordMiss(args.correlationId, reason)
      }
      return notReady(reason)
    }
    const peakBuildBytes = this.dependencies.peakBuildReservationBytes ?? args.buildReservationBytes
    let reservation = this.dependencies.admission.reserveBuild(
      key,
      args.buildReservationBytes,
      peakBuildBytes
    )
    reservation = await relieveWorkspacePathIndexAdmission({
      key,
      entry,
      initialReservation: reservation,
      buildReservationBytes: args.buildReservationBytes,
      peakBuildBytes,
      entries: this.dependencies.entries,
      admission: this.dependencies.admission,
      reclaimOptionalStructures: this.dependencies.reclaimOptionalStructures,
      spillResidentCatalog: this.dependencies.spillResidentCatalog,
      disposeEntry: this.dependencies.disposeEntry
    })
    if (!reservation.admitted) {
      this.dependencies.onInstrumentation?.({
        kind: 'admission-refusal',
        correlationId: args.correlationId,
        reason: reservation.reason
      })
      this.recordMiss(args.correlationId, 'over-budget')
      entry.retryAfterAt = Date.now() + this.dependencies.retryBackoffMilliseconds
      entry.lastFailureReason = 'over-budget'
      return notReady('over-budget')
    }
    if (this.dependencies.beforeBuild && !(await this.dependencies.beforeBuild(owner))) {
      this.dependencies.admission.releaseReservation(reservation.reservation)
      entry.freshness = 'provisional'
      entry.needsRebuild = true
      this.recordMiss(args.correlationId, 'uncovered-scope')
      return notReady('uncovered-scope')
    }
    this.recordMiss(args.correlationId, 'missing')
    // Snapshot at build start: a complete publication ends the last-known window, a partial one does not.
    const startedFromCheckpoint = entry.servingLastKnown
    const controller = new AbortController()
    entry.buildController = controller
    const buildGeneration = entry.buildGeneration + 1
    entry.buildGeneration = buildGeneration
    const request: WorkspacePathIndexBuildRequest = {
      key,
      owner,
      generationId: randomUUID(),
      buildGeneration,
      eventSequenceFence: entry.eventSequence,
      firstScope: requiredScope,
      activeWorkspace: args.activeWorkspace ?? false,
      signal: controller.signal,
      correlationId: args.correlationId,
      onInstrumentation: (event) => this.dependencies.onInstrumentation?.(event),
      onPublicationRejected: (generationId) =>
        this.dependencies.dropRejectedGeneration?.(key, generationId),
      onScopePublished: (generationId, retainedBytes, complete) => {
        if (
          entry.disposed ||
          entry.buildGeneration !== buildGeneration ||
          this.dependencies.entries.get(key) !== entry ||
          controller.signal.aborted
        ) {
          return
        }
        // Why: a generation admission refuses must never be recorded, served, or left in the worker.
        if (
          retainedBytes <= 0 ||
          !this.dependencies.admission.admitsRetained(reservation.reservation, retainedBytes)
        ) {
          this.dependencies.dropRejectedGeneration?.(key, generationId)
          return
        }
        if (entry.generationId && !complete) {
          entry.freshness = 'reconciling'
          return
        }
        if (entry.generationId && entry.generationId !== generationId) {
          this.dependencies.onGenerationChange(key)
        }
        entry.generationId = generationId
        entry.publishedScope = complete ? 'both' : requiredScope
        entry.retainedBytes = retainedBytes
        // Only a complete snapshot ends the last-known window; a single-scope publish does not.
        entry.servingLastKnown = startedFromCheckpoint && !complete
        entry.freshness =
          entry.eventSequence === request.eventSequenceFence
            ? complete
              ? 'no-known-gap'
              : 'provisional'
            : 'reconciling'
        if (complete && entry.eventSequence === request.eventSequenceFence) {
          entry.needsRebuild = false
        }
      }
    }
    startWorkspacePathIndexBuild({
      entry,
      request,
      reservation: reservation.reservation,
      admission: this.dependencies.admission,
      build: (buildRequest) =>
        this.dependencies.buildLane.run({
          signal: buildRequest.signal,
          activeWorkspace: buildRequest.activeWorkspace,
          run: () => this.dependencies.build(buildRequest)
        }),
      retryBackoffMilliseconds: this.dependencies.retryBackoffMilliseconds,
      isCurrent: () =>
        this.dependencies.entries.get(key) === entry && entry.buildGeneration === buildGeneration,
      recordFailure: () => this.recordMiss(args.correlationId, 'failed'),
      onPublished: (publishedEntry) => this.dependencies.onPublished(publishedEntry)
    })
    return notReady('building')
  }

  private disposeOwner(owner: WorkspacePathSearchOwnerIdentity): void {
    for (const entry of this.dependencies.entries.values()) {
      if (workspacePathIndexSameOwner(entry.owner, owner)) {
        this.dependencies.disposeEntry(entry)
      }
    }
    this.dependencies.onRevokeOwner?.(owner)
  }

  private recordMiss(
    correlationId: WorkspacePathSearchCorrelationId,
    reason: 'missing' | 'building' | 'over-budget' | 'failed' | 'uncovered-scope'
  ): void {
    this.dependencies.onInstrumentation?.({
      kind: 'cache-miss',
      correlationId,
      reason
    })
  }
}
