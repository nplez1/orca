import type { WorkspacePathSearchFenceIdentity } from './workspace-path-search-contract'
import type {
  WorkspacePathSearchCorrelationId,
  WorkspacePathSearchInstrumentationEvent,
  WorkspacePathSearchStrategy
} from './workspace-path-search-instrumentation'
import type { DecodedWorkspacePathCatalogBlock } from './workspace-path-catalog-blocks'
import type { WorkspacePathProvisionalPageBudget } from './workspace-path-provisional-page-budget'

export const WORKSPACE_PATH_CATALOG_QUERY_CHUNK_MILLISECONDS = 8
export const WORKSPACE_PATH_CATALOG_QUERY_CHUNK_PATHS = 131_072

export type WorkspacePathSearchCancellationToken = {
  isCancelled(): boolean
}

export class WorkspacePathSearchCancelledError extends Error {
  constructor() {
    super('Workspace path search was cancelled')
    this.name = 'WorkspacePathSearchCancelledError'
  }
}

export class WorkspacePathCatalogFoldVersionError extends Error {
  constructor() {
    super('Workspace path catalog fold data is no longer current')
    this.name = 'WorkspacePathCatalogFoldVersionError'
  }
}

export class WorkspacePathCatalogGenerationUnavailableError extends Error {
  constructor() {
    super('The requested workspace path catalog generation is unavailable')
    this.name = 'WorkspacePathCatalogGenerationUnavailableError'
  }
}

export type WorkspacePathCatalogQueryOptions = {
  identity: WorkspacePathSearchFenceIdentity
  cancellation?: WorkspacePathSearchCancellationToken
  correlationId?: WorkspacePathSearchCorrelationId
  onInstrumentation?: (event: WorkspacePathSearchInstrumentationEvent) => void
  yieldToWorker?: () => Promise<void>
  readSpilledBlock?: (blockIndex: number) => Promise<DecodedWorkspacePathCatalogBlock>
  /** Set while serving a restored provisional generation: stop the scan at a bounded prefix. */
  provisionalPageBudget?: WorkspacePathProvisionalPageBudget
}

export function shouldYieldWorkspacePathQuery(
  pathsSinceYield: number,
  chunkStart: number
): boolean {
  return (
    pathsSinceYield >= WORKSPACE_PATH_CATALOG_QUERY_CHUNK_PATHS ||
    (pathsSinceYield % 32 === 0 &&
      performance.now() - chunkStart >= WORKSPACE_PATH_CATALOG_QUERY_CHUNK_MILLISECONDS)
  )
}

export function throwIfWorkspacePathQueryCancelled(
  cancellation: WorkspacePathSearchCancellationToken | undefined
): void {
  if (cancellation?.isCancelled()) {
    throw new WorkspacePathSearchCancelledError()
  }
}

export function yieldWorkspacePathQuery(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export function emitWorkspacePathQueryInstrumentation(
  options: WorkspacePathCatalogQueryOptions,
  generationId: string,
  pathsConsidered: number,
  candidates: number,
  matches: number,
  retained: number,
  serializedBytes: number,
  durationMilliseconds: number,
  strategy: WorkspacePathSearchStrategy = 'ordered-scan',
  storageDetails?: {
    storageMode:
      | 'resident-packed'
      | 'resident-prefix-compressed'
      | 'resident-strings'
      | 'disk-spilled'
    spillBlocksRead?: number
    spillBytesRead?: number
    decodedBlockCacheHits?: number
    scanComplete?: boolean
  }
): void {
  const correlationId = options.correlationId ?? 'workspace-path-catalog-query'
  const timing: WorkspacePathSearchInstrumentationEvent = {
    kind: 'stage-timing',
    record: {
      correlationId,
      stage: 'query-strategy',
      duration: { milliseconds: durationMilliseconds, clock: 'execution-host-monotonic' }
    }
  }
  const metrics: WorkspacePathSearchInstrumentationEvent = {
    kind: 'query-metrics',
    record: {
      correlationId,
      generationId,
      strategy,
      pathsConsidered,
      candidates,
      verifications: candidates,
      exactMatches: matches,
      retained,
      serializedBytes,
      ...storageDetails
    }
  }
  options.onInstrumentation?.(timing)
  options.onInstrumentation?.(metrics)
}
