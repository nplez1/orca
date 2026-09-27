export type WorkspacePathSearchCorrelationId = string

export type HostMonotonicDuration = {
  milliseconds: number
  clock: 'execution-host-monotonic'
}

export type RendererMonotonicDuration = {
  milliseconds: number
  clock: 'renderer-monotonic'
}

export type WorkspacePathSearchStageDuration = HostMonotonicDuration | RendererMonotonicDuration

export type WorkspacePathSearchTimingStage =
  | 'input-to-dispatch'
  | 'capability-negotiation'
  | 'queue-delay'
  | 'enumeration'
  | 'normalization'
  | 'sort'
  | 'ignore-classification'
  | 'index-publication'
  | 'query-generation'
  | 'query-strategy'
  | 'query-paths-considered'
  | 'query-candidates'
  | 'query-verifications'
  | 'query-exact-matches'
  | 'query-retained'
  | 'query-bytes'
  | 'transport'
  | 'projection'
  | 'commit'
  | 'query-tagged-paint'
  | 'service-ensure'
  | 'service-query-total'
  | 'worker-round-trip'
  | 'projection-chunk'

export type WorkspacePathSearchStageTiming = {
  correlationId: WorkspacePathSearchCorrelationId
  stage: WorkspacePathSearchTimingStage
  duration: WorkspacePathSearchStageDuration
}

export type WorkspacePathSearchStrategy =
  | 'ordered-scan'
  | 'trigram-postings'
  | 'disk-block-scan'
  | 'matching-id-bitset'
  | 'live-scan'
  | 'legacy-search'

export type WorkspacePathSearchQueryMetrics = {
  correlationId: WorkspacePathSearchCorrelationId
  generationId: string | null
  strategy: WorkspacePathSearchStrategy
  pathsConsidered: number
  candidates: number
  verifications: number
  exactMatches: number
  retained: number
  serializedBytes: number
  storageMode?:
    | 'resident-packed'
    | 'resident-prefix-compressed'
    | 'resident-strings'
    | 'disk-spilled'
  spillBlocksRead?: number
  spillBytesRead?: number
  decodedBlockCacheHits?: number
  /** False when a bounded provisional page stopped before covering the scope. */
  scanComplete?: boolean
}

export type WorkspacePathSearchDiagnosticsSummary = {
  queriesServed: number
  strategies: Record<WorkspacePathSearchStrategy, number>
  cacheMissReasons: Partial<Record<WorkspacePathSearchCacheMissReason, number>>
  fallbackReasons: Record<string, number>
  admissionRefusals: number
  freshnessDowngrades: number
}

export const WORKSPACE_PATH_SEARCH_CACHE_MISS_REASONS = [
  'missing',
  'building',
  'expired',
  'over-budget',
  'failed',
  'uncovered-scope'
] as const

export type WorkspacePathSearchCacheMissReason =
  (typeof WORKSPACE_PATH_SEARCH_CACHE_MISS_REASONS)[number]

export type WorkspacePathSearchAdmissionRefusalReason = 'root-budget' | 'over-budget'

export type WorkspacePathSearchMaintenanceEvent = {
  correlationId: WorkspacePathSearchCorrelationId
  action:
    | 'reconciliation-started'
    | 'event-batch'
    | 'event-overflow'
    | 'freshness-downgrade'
    | 'delta-applied'
    | 'compaction-triggered'
  pathCount: number
  byteCount: number
  durationMilliseconds: number
  reason?: string
}

export type WorkspacePathSearchInstrumentationEvent =
  | { kind: 'stage-timing'; record: WorkspacePathSearchStageTiming }
  | { kind: 'query-metrics'; record: WorkspacePathSearchQueryMetrics }
  | { kind: 'maintenance'; record: WorkspacePathSearchMaintenanceEvent }
  | {
      kind: 'cache-miss'
      correlationId: WorkspacePathSearchCorrelationId
      reason: WorkspacePathSearchCacheMissReason
    }
  | {
      kind: 'degradation'
      correlationId: WorkspacePathSearchCorrelationId
      reason: string
    }
  | {
      kind: 'admission-refusal'
      correlationId: WorkspacePathSearchCorrelationId
      reason: WorkspacePathSearchAdmissionRefusalReason
    }
