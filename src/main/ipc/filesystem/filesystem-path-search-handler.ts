import { performance } from 'node:perf_hooks'
import { ipcMain } from 'electron'
import { buildExcludePathPrefixes } from '../../../shared/quick-open-filter'
import {
  WORKSPACE_PATH_SEARCH_TRANSPORT_BYTE_CEILINGS,
  validateWorkspacePathSearchQuery,
  type WorkspacePathSearchFenceIdentity,
  type WorkspacePathSearchOwnerIdentity,
  type WorkspacePathSearchConsumerSequence
} from '../../../shared/workspace-path-search-contract'
import { workspacePathCatalogFoldCacheKey } from '../../../shared/workspace-path-catalog'
import {
  createCompleteWorkspacePathSearchResponse,
  createPartialWorkspacePathSearchResponse
} from '../../../shared/workspace-path-search-response'
import { toFilePathSearchResult } from '../../../shared/workspace-path-search-file-result'
import { WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES } from '../../../shared/__fixtures__/workspace-path-memory-measurement'
import type { FilePathSearchResult } from '../../../shared/file-path-search-result'
import type { PathSearchMode } from '../../../shared/quick-open-path-search'
import { resolveQuickOpenResultLimit } from '../../../shared/quick-open-listing-limits'
import { searchQuickOpenFilePaths } from '../filesystem-search-file-paths'
import { resolveAuthorizedPath } from '../filesystem-auth'
import { recordQuickOpenPathSearchFallback } from '../quick-open-path-inventory'
import { searchSshWorkspaceNameFilter } from './filesystem-remote-path-search'
import { WORKSPACE_PATH_INDEX_LISTING_POLICY_VERSION } from '../../workspace-path-index/workspace-path-index-runtime'
import type { WorkspacePathIndexService } from '../../workspace-path-index/workspace-path-index-service'
import { runWorkspacePathIndexIfEnabled } from '../../workspace-path-index/workspace-path-index-feature-switch'
import type { WorkspacePathSearchCorrelationId } from '../../../shared/workspace-path-search-instrumentation'
import type { FilesystemHandlerContext } from './filesystem-handler-context'

/** Routes local name filters through the authorized worker-owned generation. */
export function registerFilesystemPathSearchHandler(
  context: FilesystemHandlerContext,
  pathIndexService: WorkspacePathIndexService
): void {
  const { store, listFilesCancellations } = context
  const sequenceByConsumer = new Map<string, number>()
  ipcMain.handle(
    'fs:searchFilePaths',
    async (
      event,
      args: {
        rootPath: string
        connectionId?: string
        excludePaths?: string[]
        requestToken?: string
        query: string
        limit?: number
        mode?: PathSearchMode
        includeIgnoredFiles?: boolean
        includeDotfiles?: boolean
        correlationId?: WorkspacePathSearchCorrelationId
        consumerId?: unknown
        consumerSequence?: unknown
      }
    ): Promise<FilePathSearchResult> => {
      const controller = listFilesCancellations.begin(event, args.requestToken)
      const limit = resolveQuickOpenResultLimit(args.limit)
      try {
        const rendererConsumer = readRendererConsumer(args)
        if (args.mode === 'name-filter') {
          const validation = validateWorkspacePathSearchQuery(args.query)
          if (!validation.ok) {
            throw new TypeError(`Workspace path search query is invalid: ${validation.reason}`)
          }
        }
        if (args.connectionId && args.mode === 'name-filter') {
          return await searchSshWorkspaceNameFilter({
            connectionId: args.connectionId,
            rootPath: args.rootPath,
            query: args.query,
            limit,
            excludePaths: args.excludePaths,
            includeDotfiles: args.includeDotfiles,
            includeIgnoredFiles: args.includeIgnoredFiles,
            correlationId: args.correlationId,
            signal: controller?.signal
          })
        }
        const authorizedRootPath =
          args.mode === 'name-filter'
            ? await resolveAuthorizedPath(args.rootPath, store)
            : undefined
        let identity: WorkspacePathSearchFenceIdentity | null = null
        let degradationReason: string | undefined
        if (authorizedRootPath && args.mode === 'name-filter') {
          let consumer = rendererConsumer
          if (!consumer) {
            const consumerId = String(event.sender.id)
            const sequence = (sequenceByConsumer.get(consumerId) ?? 0) + 1
            sequenceByConsumer.set(consumerId, sequence)
            consumer = { consumerId, sequence }
          }
          const includeIgnoredFiles = args.includeIgnoredFiles ?? true
          const searchIdentity: WorkspacePathSearchFenceIdentity = {
            query: args.query,
            consumer,
            owner: localWorkspacePathSearchOwner(authorizedRootPath),
            generationId: null,
            mode: 'name-filter',
            scope: {
              pathSet: includeIgnoredFiles ? 'all' : 'included',
              includeDotfiles: args.includeDotfiles ?? true,
              includeIgnoredFiles,
              excludePathSegments: buildExcludePathPrefixes(
                authorizedRootPath,
                args.excludePaths
              ).map((path) => path.split('/'))
            },
            pageBudget: {
              maxPaths: limit,
              maxSerializedBytes: WORKSPACE_PATH_SEARCH_TRANSPORT_BYTE_CEILINGS.relayFramePayload
            }
          }
          identity = searchIdentity
          const indexedAttempt = await runWorkspacePathIndexIfEnabled(() =>
            pathIndexService.search({
              identity: searchIdentity,
              listingPolicyVersion: WORKSPACE_PATH_INDEX_LISTING_POLICY_VERSION,
              foldVersion: workspacePathCatalogFoldCacheKey(),
              buildReservationBytes: WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES,
              correlationId:
                args.correlationId ?? `search-${consumer.consumerId}-${consumer.sequence}`
            })
          )
          if (indexedAttempt.enabled) {
            const indexed = indexedAttempt.value
            if (indexed.ready) {
              const response = indexed.response
              if (
                response.state.coverage === 'complete' &&
                response.state.freshness === 'no-known-gap' &&
                response.state.countProvenance === 'exact-snapshot' &&
                response.count.provenance === 'exact-snapshot'
              ) {
                return toFilePathSearchResult(response)
              }
              degradationReason = response.degradationReason ?? 'building'
              if (shouldSkipMainThreadFallback(degradationReason)) {
                return unavailableWorkspacePathSearch(identity, degradationReason)
              }
            } else {
              degradationReason = indexed.reason
              if (shouldSkipMainThreadFallback(degradationReason)) {
                return unavailableWorkspacePathSearch(identity, degradationReason)
              }
            }
          } else {
            degradationReason = 'feature-disabled'
          }
        }
        if (identity && degradationReason) {
          pathIndexService.recordDegradation(
            args.correlationId ??
              `search-${identity.consumer.consumerId}-${identity.consumer.sequence}`,
            degradationReason
          )
        }
        const fallbackStartedAt = performance.now()
        let fallbackCounts = {
          pathsConsidered: 0,
          candidates: 0,
          verifications: 0,
          queryGenerationDurationMs: 0,
          queryPathsDurationMs: 0
        }
        const result = await searchQuickOpenFilePaths(args.rootPath, store, {
          query: args.query,
          limit,
          mode: args.mode,
          excludePaths: args.excludePaths,
          includeIgnoredFiles: args.includeIgnoredFiles,
          includeDotfiles: args.includeDotfiles,
          signal: controller?.signal,
          ...(args.mode === 'name-filter'
            ? { onQueryMetrics: (counts: typeof fallbackCounts) => (fallbackCounts = counts) }
            : {})
        })
        if (args.mode === 'name-filter') {
          recordQuickOpenPathSearchFallback(
            args.rootPath,
            args.correlationId,
            performance.now() - fallbackStartedAt,
            result,
            fallbackCounts
          )
        }
        const legacyResult: FilePathSearchResult = {
          files: result.paths,
          totalCount: result.totalCount,
          truncated: result.truncated
        }
        if (!identity) {
          return legacyResult
        }
        const liveResponse = createCompleteWorkspacePathSearchResponse({
          requestIdentity: identity,
          paths: result.paths,
          totalCount: result.totalCount,
          generationId: `live-${identity.consumer.sequence}`
        })
        return {
          ...legacyResult,
          workspacePathSearch: {
            ...liveResponse,
            degradationReason: degradationReason ?? 'failed'
          }
        }
      } finally {
        listFilesCancellations.finish(event, args.requestToken, controller)
      }
    }
  )
}

function shouldSkipMainThreadFallback(reason: string): boolean {
  return reason === 'cancelled' || reason === 'authorization-revoked'
}

function unavailableWorkspacePathSearch(
  identity: WorkspacePathSearchFenceIdentity,
  reason: string
): FilePathSearchResult {
  return {
    files: [],
    totalCount: null,
    truncated: true,
    workspacePathSearch: createPartialWorkspacePathSearchResponse({
      requestIdentity: identity,
      paths: [],
      generationId: `unavailable-${identity.consumer.sequence}`,
      degradationReason: reason
    })
  }
}

function readRendererConsumer(args: {
  consumerId?: unknown
  consumerSequence?: unknown
}): WorkspacePathSearchConsumerSequence | null {
  if (args.consumerId === undefined && args.consumerSequence === undefined) {
    return null
  }
  if (
    typeof args.consumerId !== 'string' ||
    args.consumerId.length === 0 ||
    args.consumerId.length > 128 ||
    args.consumerId.trim().length === 0 ||
    hasControlCharacters(args.consumerId) ||
    typeof args.consumerSequence !== 'number' ||
    !Number.isSafeInteger(args.consumerSequence) ||
    args.consumerSequence <= 0
  ) {
    throw new TypeError('Workspace path search consumer identity is invalid')
  }
  return { consumerId: args.consumerId, sequence: args.consumerSequence }
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 31 || (code >= 127 && code <= 159)) {
      return true
    }
  }
  return false
}

function localWorkspacePathSearchOwner(rootPath: string): WorkspacePathSearchOwnerIdentity {
  return {
    executionHost: { provider: 'local', incarnationId: String(process.pid) },
    authorizedCanonicalRoot: rootPath
  }
}
