import { describe, expect, it } from 'vitest'
import type { WorkspacePathSearchInstrumentationEvent } from '../../shared/workspace-path-search-instrumentation'
import { summarizeWorkspacePathSearchDiagnostics } from './workspace-path-search-diagnostics-summary'

const events: WorkspacePathSearchInstrumentationEvent[] = [
  {
    kind: 'query-metrics',
    record: {
      correlationId: 'query-id',
      generationId: 'generation-id',
      strategy: 'ordered-scan',
      pathsConsidered: 8,
      candidates: 4,
      verifications: 4,
      exactMatches: 2,
      retained: 2,
      serializedBytes: 90
    }
  },
  {
    kind: 'query-metrics',
    record: {
      correlationId: 'query-id',
      generationId: null,
      strategy: 'live-scan',
      pathsConsidered: 8,
      candidates: 4,
      verifications: 4,
      exactMatches: 2,
      retained: 2,
      serializedBytes: 90
    }
  },
  { kind: 'cache-miss', correlationId: 'query-id', reason: 'building' },
  { kind: 'degradation', correlationId: 'query-id', reason: 'feature-disabled' },
  { kind: 'admission-refusal', correlationId: 'query-id', reason: 'over-budget' },
  {
    kind: 'maintenance',
    record: {
      correlationId: 'query-id',
      action: 'freshness-downgrade',
      pathCount: 3,
      byteCount: 40,
      durationMilliseconds: 2,
      reason: 'watcher-gap'
    }
  }
]

describe('workspace path search diagnostics summary', () => {
  it('counts strategies, miss/fallback reasons, admission refusals, and freshness downgrades', () => {
    expect(summarizeWorkspacePathSearchDiagnostics(events)).toMatchObject({
      queriesServed: 1,
      strategies: {
        'ordered-scan': 0,
        'trigram-postings': 0,
        'matching-id-bitset': 0,
        'live-scan': 1,
        'legacy-search': 0
      },
      cacheMissReasons: { building: 1 },
      fallbackReasons: { 'feature-disabled': 1 },
      admissionRefusals: 1,
      freshnessDowngrades: 1
    })
  })

  it('counts an ordered scan when it is the strategy that serves the query', () => {
    const orderedScanEvents = events.filter(
      (event) => event.kind === 'query-metrics' && event.record.strategy === 'ordered-scan'
    )
    const summary = summarizeWorkspacePathSearchDiagnostics(orderedScanEvents)
    expect(summary.queriesServed).toBe(1)
    expect(summary.strategies['ordered-scan']).toBe(1)
  })

  it('does not count an index attempt as served when its fallback did not complete', () => {
    const result = summarizeWorkspacePathSearchDiagnostics([
      {
        kind: 'query-metrics',
        record: {
          correlationId: 'failed-query',
          generationId: 'stale-generation',
          strategy: 'ordered-scan',
          pathsConsidered: 1,
          candidates: 1,
          verifications: 1,
          exactMatches: 0,
          retained: 0,
          serializedBytes: 2
        }
      },
      { kind: 'degradation', correlationId: 'failed-query', reason: 'failed' }
    ])

    expect(result.queriesServed).toBe(0)
    expect(result.strategies['ordered-scan']).toBe(0)
    expect(result.fallbackReasons.failed).toBe(1)
  })

  it('returns aggregate numbers only, not correlation, path, or query values', () => {
    const summary = summarizeWorkspacePathSearchDiagnostics(events)
    const serialized = JSON.stringify(summary)
    expect(serialized).not.toContain('query-id')
    expect(serialized).not.toContain('generation-id')
    expect(serialized).not.toContain('workspace/private-project')
    expect(serialized).not.toContain('target.ts')
  })
})
