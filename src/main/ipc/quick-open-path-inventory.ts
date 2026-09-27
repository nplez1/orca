import type { Store } from '../persistence'
import {
  WORKSPACE_PATH_SEARCH_TRANSPORT_BYTE_CEILINGS,
  type WorkspacePathSearchPathSet
} from '../../shared/workspace-path-search-contract'
import { workspacePathCatalogFoldCacheKey } from '../../shared/workspace-path-catalog'
import { toFilePathSearchResult } from '../../shared/workspace-path-search-file-result'
import type {
  WorkspacePathSearchCorrelationId,
  WorkspacePathSearchQueryMetrics
} from '../../shared/workspace-path-search-instrumentation'
import type { QuickOpenFilePathSearchResult } from './filesystem-search-file-paths'
import {
  clearLocalWorkspacePathIndex,
  createLocalWorkspacePathIndexService,
  evictLocalWorkspacePathIndex,
  releaseLocalWorkspacePathIndexLease,
  invalidateLocalWorkspacePathIndex,
  WORKSPACE_PATH_INDEX_LISTING_POLICY_VERSION
} from '../workspace-path-index/workspace-path-index-runtime'
import {
  clearQuickOpenPathSearchInstrumentation as clearRecordedInstrumentation,
  exportQuickOpenPathSearchInstrumentation as exportRecordedInstrumentation,
  recordQuickOpenPathSearchFallback as recordFallbackInstrumentation,
  type QuickOpenPathSearchInstrumentationRecord
} from './workspace-path-search-instrumentation-recorder'
import { WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES } from '../../shared/__fixtures__/workspace-path-memory-measurement'
import { buildExcludePathPrefixes } from '../../shared/quick-open-filter'
import { isWorkspacePathIndexEnabled } from '../workspace-path-index/workspace-path-index-feature-switch'

export type QuickOpenPathInventoryMatch = {
  paths: string[]
  totalCount: number
  truncated: boolean
  ignoredPaths?: string[]
}

let compatibilitySequence = 0

export function exportQuickOpenPathSearchInstrumentation(): QuickOpenPathSearchInstrumentationRecord[] {
  return exportRecordedInstrumentation()
}

export function clearQuickOpenPathSearchInstrumentation(): void {
  clearRecordedInstrumentation()
}

export function prewarmQuickOpenPathInventory(
  rootPath: string,
  store: Store,
  options: {
    includeIgnoredFiles?: boolean
    correlationId?: WorkspacePathSearchCorrelationId
    authorizedRootPath?: string
  } = {}
): void {
  if (!isWorkspacePathIndexEnabled()) {
    return
  }
  void createLocalWorkspacePathIndexService(store)
    .ensure({
      owner: localOwner(options.authorizedRootPath ?? rootPath),
      listingPolicyVersion: WORKSPACE_PATH_INDEX_LISTING_POLICY_VERSION,
      foldVersion: workspacePathCatalogFoldCacheKey(),
      buildReservationBytes: rootBudget(),
      firstScope: options.includeIgnoredFiles ? 'all' : 'included',
      activeWorkspace: true,
      correlationId: options.correlationId ?? 'quick-open-prewarm'
    })
    .catch(() => undefined)
}

export function acquireQuickOpenPathInventoryLease(
  rootPath: string,
  store: Store,
  options: {
    includeIgnoredFiles: boolean
    correlationId?: WorkspacePathSearchCorrelationId
    authorizedRootPath?: string
  }
): Promise<string | null> {
  if (!isWorkspacePathIndexEnabled()) {
    return Promise.resolve(null)
  }
  return createLocalWorkspacePathIndexService(store).acquireLease({
    owner: localOwner(options.authorizedRootPath ?? rootPath),
    listingPolicyVersion: WORKSPACE_PATH_INDEX_LISTING_POLICY_VERSION,
    foldVersion: workspacePathCatalogFoldCacheKey(),
    buildReservationBytes: rootBudget(),
    firstScope: options.includeIgnoredFiles ? 'all' : 'included',
    correlationId: options.correlationId ?? 'quick-open-lease'
  })
}

export function releaseQuickOpenPathInventoryLease(_rootPath: string, leaseId: string): void {
  releaseLocalWorkspacePathIndexLease(leaseId)
}

export async function queryQuickOpenPathInventory(
  rootPath: string,
  store: Store,
  args: {
    query: string
    limit: number
    excludePaths?: string[]
    includeIgnoredFiles: boolean
    correlationId?: WorkspacePathSearchCorrelationId
    authorizedRootPath?: string
  }
): Promise<QuickOpenPathInventoryMatch | null> {
  if (!isWorkspacePathIndexEnabled() || args.limit <= 0 || !args.query.trim()) {
    return null
  }
  const authorizedRootPath = args.authorizedRootPath ?? rootPath
  const pathSet: WorkspacePathSearchPathSet = args.includeIgnoredFiles ? 'all' : 'included'
  const consumerId = 'quick-open-compatibility'
  const identity = {
    query: args.query,
    consumer: { consumerId, sequence: ++compatibilitySequence },
    owner: localOwner(authorizedRootPath),
    generationId: null,
    mode: 'name-filter' as const,
    scope: {
      pathSet,
      includeDotfiles: true,
      includeIgnoredFiles: args.includeIgnoredFiles,
      excludePathSegments: buildExcludePathPrefixes(authorizedRootPath, args.excludePaths).map(
        (path) => path.split('/')
      )
    },
    pageBudget: {
      maxPaths: args.limit,
      maxSerializedBytes: WORKSPACE_PATH_SEARCH_TRANSPORT_BYTE_CEILINGS.relayFramePayload
    }
  }
  const result = await createLocalWorkspacePathIndexService(store).search({
    identity,
    listingPolicyVersion: WORKSPACE_PATH_INDEX_LISTING_POLICY_VERSION,
    foldVersion: workspacePathCatalogFoldCacheKey(),
    buildReservationBytes: rootBudget(),
    correlationId: args.correlationId ?? `quick-open-query-${compatibilitySequence}`
  })
  if (!result.ready) {
    return null
  }
  const legacy = toFilePathSearchResult(result.response)
  if (legacy.totalCount === null) {
    return null
  }
  return {
    paths: legacy.files,
    totalCount: legacy.totalCount,
    truncated: legacy.truncated,
    ...(legacy.ignoredFiles === undefined ? {} : { ignoredPaths: legacy.ignoredFiles })
  }
}

export function recordQuickOpenPathSearchFallback(
  rootPath: string,
  correlationId: WorkspacePathSearchCorrelationId | undefined,
  durationMilliseconds: number,
  result: QuickOpenFilePathSearchResult,
  counts: Pick<
    WorkspacePathSearchQueryMetrics,
    'pathsConsidered' | 'candidates' | 'verifications'
  > & {
    queryGenerationDurationMs: number
    queryPathsDurationMs: number
  }
): void {
  recordFallbackInstrumentation({
    rootPath,
    correlationId,
    durationMilliseconds,
    result,
    pathsConsidered: counts.pathsConsidered,
    candidates: counts.candidates,
    verifications: counts.verifications,
    queryGenerationDurationMs: counts.queryGenerationDurationMs,
    queryPathsDurationMs: counts.queryPathsDurationMs
  })
}

export function invalidateQuickOpenPathInventory(
  rootPath: string,
  reason?: string,
  eventCount?: number
): void {
  invalidateLocalWorkspacePathIndex(rootPath, reason, eventCount)
}

export function evictQuickOpenPathInventory(rootPath: string): void {
  evictLocalWorkspacePathIndex(rootPath)
}

export function clearQuickOpenPathInventories(): void {
  compatibilitySequence = 0
  clearQuickOpenPathSearchInstrumentation()
  clearLocalWorkspacePathIndex()
}

function localOwner(rootPath: string) {
  return {
    executionHost: { provider: 'local', incarnationId: String(process.pid) },
    authorizedCanonicalRoot: rootPath
  }
}

function rootBudget(): number {
  return WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES
}
