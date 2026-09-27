import { randomUUID } from 'node:crypto'
import { NameFilterPathMatcher } from '../../../shared/quick-open-path-search'
import { QUICK_OPEN_LISTING_MAX_RESULTS } from '../../../shared/quick-open-listing-limits'
import {
  buildExcludePathPrefixes,
  shouldExcludeQuickOpenRelPath
} from '../../../shared/quick-open-filter'
import type { FilePathSearchResult } from '../../../shared/file-path-search-result'
import { toFilePathSearchResult } from '../../../shared/workspace-path-search-file-result'
import {
  validateWorkspacePathSearchQuery,
  type WorkspacePathSearchRequest,
  type WorkspacePathSearchResponse
} from '../../../shared/workspace-path-search-contract'
import { RELAY_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR } from '../../../shared/workspace-path-search-capability'
import { limitWorkspacePathSearchRequestToCapability } from '../../../shared/workspace-path-search-request-budget'
import { createPartialWorkspacePathSearchResponse } from '../../../shared/workspace-path-search-response'
import { requireSshFilesystemProvider } from '../../providers/ssh-filesystem-dispatch'

export async function searchSshWorkspaceNameFilter(args: {
  connectionId: string
  rootPath: string
  query: string
  limit: number
  excludePaths?: string[]
  includeDotfiles?: boolean
  includeIgnoredFiles?: boolean
  correlationId?: string
  signal?: AbortSignal
}): Promise<FilePathSearchResult> {
  const query = validateWorkspacePathSearchQuery(args.query, 'remote')
  if (!query.ok || !query.query.trim()) {
    throw new Error('Invalid remote workspace path search query')
  }
  const provider = requireSshFilesystemProvider(args.connectionId)
  const scope = {
    pathSet: args.includeIgnoredFiles === false ? ('included' as const) : ('all' as const),
    includeDotfiles: args.includeDotfiles ?? true,
    includeIgnoredFiles: args.includeIgnoredFiles ?? true,
    excludePathSegments: buildExcludePathPrefixes(args.rootPath, args.excludePaths).map((path) =>
      path.split('/')
    )
  }
  const correlationId = args.correlationId ?? randomUUID()
  const request: WorkspacePathSearchRequest = {
    identity: {
      query: query.query,
      consumer: { consumerId: correlationId, sequence: 1 },
      owner: {
        executionHost: { provider: 'ssh', incarnationId: args.connectionId },
        authorizedCanonicalRoot: args.rootPath
      },
      generationId: null,
      mode: 'name-filter',
      scope,
      pageBudget: {
        maxPaths: Math.max(
          1,
          Math.min(args.limit, RELAY_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR.maxPagePaths)
        ),
        maxSerializedBytes: RELAY_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR.maxPageSerializedBytes
      }
    },
    correlationId
  }
  const peerCapability = await provider.workspacePathSearchCapability?.({ signal: args.signal })
  const negotiatedRequest = peerCapability
    ? limitWorkspacePathSearchRequestToCapability(request, peerCapability)
    : request
  const response =
    (await provider.searchWorkspacePathNameFilter?.(args.rootPath, negotiatedRequest, {
      signal: args.signal
    })) ?? (await searchLegacySshPaths(provider, args, request))
  return toFilePathSearchResult(response)
}

async function searchLegacySshPaths(
  provider: ReturnType<typeof requireSshFilesystemProvider>,
  args: {
    rootPath: string
    excludePaths?: string[]
    includeDotfiles?: boolean
    signal?: AbortSignal
  },
  request: WorkspacePathSearchRequest
): Promise<WorkspacePathSearchResponse> {
  if (!request.identity.scope.includeIgnoredFiles) {
    return createPartialWorkspacePathSearchResponse({
      requestIdentity: request.identity,
      paths: [],
      generationId: `ssh-legacy-${request.correlationId}`,
      degradationReason: 'classification-pending'
    })
  }
  const excludePrefixes = buildExcludePathPrefixes(args.rootPath, args.excludePaths)
  const listed = await provider.listFiles(args.rootPath, {
    excludePaths: args.excludePaths,
    maxResults: QUICK_OPEN_LISTING_MAX_RESULTS,
    signal: args.signal
  })
  const matcher = new NameFilterPathMatcher(
    request.identity.query,
    request.identity.pageBudget.maxPaths
  )
  for (const path of listed) {
    if (
      shouldExcludeQuickOpenRelPath(path, excludePrefixes) ||
      (args.includeDotfiles === false && containsDotfileSegment(path))
    ) {
      continue
    }
    matcher.consider(path)
  }
  return createPartialWorkspacePathSearchResponse({
    requestIdentity: request.identity,
    paths: matcher.result().paths,
    generationId: `ssh-legacy-${request.correlationId}`,
    degradationReason: request.identity.scope.includeIgnoredFiles
      ? 'unsupported'
      : 'classification-pending'
  })
}

function containsDotfileSegment(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.'))
}
