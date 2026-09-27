import type {
  WorkspacePathSearchFenceIdentity,
  WorkspacePathSearchFreshness,
  WorkspacePathSearchOwnerIdentity
} from '../../shared/workspace-path-search-contract'
import type { WorkspacePathIndexDeltaMutation } from './workspace-path-index-worker-protocol'

export type WorkspacePathIndexEntry = {
  key: string
  owner: WorkspacePathSearchOwnerIdentity
  generationId: string | null
  publishedScope: 'included' | 'all' | 'both' | null
  buildGeneration: number
  retainedBytes: number
  leases: Set<string>
  buildPromise: Promise<unknown> | null
  buildController: AbortController | null
  lastUsedAt: number
  retryAfterAt: number
  lastFailureReason: string | null
  disposed: boolean
  freshness: WorkspacePathSearchFreshness
  needsRebuild: boolean
  /** True while a checkpoint generation is served provisionally and has not been reconciled. */
  servingLastKnown: boolean
  eventSequence: number
  continuityEpoch: number
  activeReconciliations: number
  pendingMutations: WorkspacePathIndexDeltaMutation[]
  pendingMutationBytes: number
  pendingOverflow: boolean
  validationTimer: ReturnType<typeof setTimeout> | null
  freshnessDeadlineTimer: ReturnType<typeof setTimeout> | null
  reconciliationRetryCount: number
  validationRequest: {
    listingPolicyVersion: string
    foldVersion: string
    buildReservationBytes: number
    firstScope: 'included' | 'all'
    activeWorkspace: boolean
    correlationId: string
  } | null
}

export function createWorkspacePathIndexEntry(
  key: string,
  owner: WorkspacePathSearchOwnerIdentity
): WorkspacePathIndexEntry {
  return {
    key,
    owner,
    generationId: null,
    publishedScope: null,
    buildGeneration: 0,
    retainedBytes: 0,
    leases: new Set(),
    buildPromise: null,
    buildController: null,
    lastUsedAt: Date.now(),
    retryAfterAt: 0,
    lastFailureReason: null,
    disposed: false,
    freshness: 'no-known-gap',
    needsRebuild: false,
    servingLastKnown: false,
    eventSequence: 0,
    continuityEpoch: 0,
    activeReconciliations: 0,
    pendingMutations: [],
    pendingMutationBytes: 0,
    pendingOverflow: false,
    validationTimer: null,
    freshnessDeadlineTimer: null,
    reconciliationRetryCount: 0,
    validationRequest: null
  }
}

export function workspacePathIndexOwnershipKey(
  owner: WorkspacePathSearchOwnerIdentity,
  listingPolicyVersion: string,
  foldVersion: string
): string {
  return JSON.stringify([
    owner.executionHost.provider,
    owner.executionHost.incarnationId,
    owner.authorizedCanonicalRoot,
    listingPolicyVersion,
    foldVersion
  ])
}

export function workspacePathIndexSameOwner(
  left: WorkspacePathSearchOwnerIdentity,
  right: WorkspacePathSearchOwnerIdentity
): boolean {
  return (
    left.executionHost.provider === right.executionHost.provider &&
    left.executionHost.incarnationId === right.executionHost.incarnationId &&
    left.authorizedCanonicalRoot === right.authorizedCanonicalRoot
  )
}

export function workspacePathIndexConsumerKey(identity: WorkspacePathSearchFenceIdentity): string {
  return [
    identity.owner.executionHost.provider,
    identity.owner.executionHost.incarnationId,
    identity.consumer.consumerId
  ].join(':')
}
