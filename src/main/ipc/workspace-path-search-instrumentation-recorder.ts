import { createHash } from 'node:crypto'
import type {
  WorkspacePathSearchCorrelationId,
  WorkspacePathSearchInstrumentationEvent
} from '../../shared/workspace-path-search-instrumentation'
import type { QuickOpenFilePathSearchResult } from './filesystem-search-file-paths'
import { getLocalWatcherRoot } from './filesystem-watcher-paths'
export type QuickOpenPathSearchInstrumentationRecord = {
  correlationId: WorkspacePathSearchCorrelationId
  workspaceIdentityHash: string
  events: readonly WorkspacePathSearchInstrumentationEvent[]
}

const records: QuickOpenPathSearchInstrumentationRecord[] = []
const MAX_RECORDS = 128

export function exportQuickOpenPathSearchInstrumentation(): QuickOpenPathSearchInstrumentationRecord[] {
  return records.map((record) => ({ ...record, events: [...record.events] }))
}

export function clearQuickOpenPathSearchInstrumentation(): void {
  records.length = 0
}

export function recordQuickOpenPathSearchFallback(args: {
  rootPath: string
  correlationId?: WorkspacePathSearchCorrelationId
  durationMilliseconds: number
  result: QuickOpenFilePathSearchResult
  pathsConsidered: number
  candidates: number
  verifications: number
  queryGenerationDurationMs: number
  queryPathsDurationMs: number
}): void {
  const correlationId = args.correlationId ?? 'workspace-path-search-live-scan'
  const serializedBytes = Buffer.byteLength(
    JSON.stringify({ files: args.result.paths, totalCount: args.result.totalCount })
  )
  records.push({
    correlationId,
    workspaceIdentityHash: createHash('sha256')
      .update(getLocalWatcherRoot(args.rootPath).key)
      .digest('hex')
      .slice(0, 16),
    events: [
      stage(correlationId, 'query-generation', args.queryGenerationDurationMs),
      stage(correlationId, 'enumeration', args.durationMilliseconds),
      stage(correlationId, 'query-paths-considered', args.queryPathsDurationMs),
      {
        kind: 'query-metrics',
        record: {
          correlationId,
          generationId: null,
          strategy: 'live-scan',
          pathsConsidered: args.pathsConsidered,
          candidates: args.candidates,
          verifications: args.verifications,
          exactMatches: args.result.totalCount,
          retained: args.result.paths.length,
          serializedBytes
        }
      }
    ]
  })
  if (records.length > MAX_RECORDS) {
    records.shift()
  }
}

function stage(
  correlationId: WorkspacePathSearchCorrelationId,
  name: 'query-generation' | 'enumeration' | 'query-paths-considered',
  milliseconds: number
): QuickOpenPathSearchInstrumentationRecord['events'][number] {
  return {
    kind: 'stage-timing',
    record: {
      correlationId,
      stage: name,
      duration: { milliseconds: Math.max(0, milliseconds), clock: 'execution-host-monotonic' }
    }
  }
}
