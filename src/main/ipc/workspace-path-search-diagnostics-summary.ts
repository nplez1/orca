import type {
  WorkspacePathSearchCacheMissReason,
  WorkspacePathSearchDiagnosticsSummary,
  WorkspacePathSearchInstrumentationEvent,
  WorkspacePathSearchStrategy
} from '../../shared/workspace-path-search-instrumentation'

export function summarizeWorkspacePathSearchDiagnostics(
  events: readonly WorkspacePathSearchInstrumentationEvent[]
): WorkspacePathSearchDiagnosticsSummary {
  const strategies: Record<WorkspacePathSearchStrategy, number> = {
    'ordered-scan': 0,
    'trigram-postings': 0,
    'matching-id-bitset': 0,
    'disk-block-scan': 0,
    'live-scan': 0,
    'legacy-search': 0
  }
  const cacheMissReasons: Partial<Record<WorkspacePathSearchCacheMissReason, number>> = {
    missing: 0,
    building: 0,
    expired: 0,
    'over-budget': 0,
    failed: 0,
    'uncovered-scope': 0
  }
  const fallbackReasons: Record<string, number> = {
    missing: 0,
    building: 0,
    expired: 0,
    'over-budget': 0,
    failed: 0,
    'uncovered-scope': 0,
    'classification-pending': 0,
    interrupted: 0,
    disconnected: 0,
    'transport-budget': 0,
    unsupported: 0,
    'feature-disabled': 0
  }
  const strategiesByCorrelationId = new Map<string, WorkspacePathSearchStrategy[]>()
  const degradedCorrelationIds = new Set<string>()
  let queriesServed = 0
  let admissionRefusals = 0
  let freshnessDowngrades = 0

  for (const event of events) {
    switch (event.kind) {
      case 'query-metrics': {
        const strategiesForQuery = strategiesByCorrelationId.get(event.record.correlationId) ?? []
        strategiesForQuery.push(event.record.strategy)
        strategiesByCorrelationId.set(event.record.correlationId, strategiesForQuery)
        break
      }
      case 'cache-miss':
        cacheMissReasons[event.reason] = (cacheMissReasons[event.reason] ?? 0) + 1
        break
      case 'degradation':
        degradedCorrelationIds.add(event.correlationId)
        fallbackReasons[event.reason] = (fallbackReasons[event.reason] ?? 0) + 1
        break
      case 'admission-refusal':
        admissionRefusals += 1
        break
      case 'maintenance':
        if (event.record.action === 'freshness-downgrade') {
          freshnessDowngrades += 1
        }
        break
      case 'stage-timing':
        break
    }
  }

  for (const [correlationId, observedStrategies] of strategiesByCorrelationId) {
    const strategy = degradedCorrelationIds.has(correlationId)
      ? observedStrategies.includes('live-scan')
        ? 'live-scan'
        : undefined
      : ((observedStrategies.includes('live-scan') ? 'live-scan' : undefined) ??
        (observedStrategies.includes('legacy-search') ? 'legacy-search' : undefined) ??
        observedStrategies.at(-1))
    if (strategy) {
      queriesServed += 1
      strategies[strategy] += 1
    }
  }

  return {
    queriesServed,
    strategies,
    cacheMissReasons,
    fallbackReasons,
    admissionRefusals,
    freshnessDowngrades
  }
}
