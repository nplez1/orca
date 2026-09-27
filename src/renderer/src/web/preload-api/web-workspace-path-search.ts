import { NameFilterPathMatcher } from '../../../../shared/quick-open-path-search'
import {
  buildExcludePathPrefixes,
  shouldExcludeQuickOpenRelPath
} from '../../../../shared/quick-open-filter'
import type { FilePathSearchResult } from '../../../../shared/file-path-search-result'
import {
  WORKSPACE_PATH_SEARCH_LOCAL_EXPLORER_MAX_PAGE_PATHS,
  validateWorkspacePathSearchQuery,
  type WorkspacePathSearchFenceIdentity,
  type WorkspacePathSearchRequest,
  type WorkspacePathSearchScopeDescriptor
} from '../../../../shared/workspace-path-search-contract'
import { createPartialWorkspacePathSearchResponse } from '../../../../shared/workspace-path-search-response'
import { parseWorkspacePathSearchWireResponse } from '../../../../shared/workspace-path-search-wire-response'
import { toFilePathSearchResult } from '../../../../shared/workspace-path-search-file-result'
import { RELAY_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR } from '../../../../shared/workspace-path-search-capability'
import { readWebWorkspacePathSearchCapability } from './web-workspace-path-search-capability'
import type { RuntimeFileListResult } from '../../../../shared/runtime-types'
import { callRuntimeResult } from './web-runtime-calls'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import { createBrowserUuid } from '@/lib/browser-uuid'

export async function searchWebWorkspaceNameFilter(args: {
  worktree: { id: string; path: string }
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
    throw new Error('Remote filename filter query is too large or invalid')
  }
  const capability = await readWebWorkspacePathSearchCapability()
  if (args.signal?.aborted) {
    throw args.signal.reason ?? new Error('Workspace path search cancelled')
  }
  const scope = createScope(args.worktree.path, args)
  const descriptor = capability.descriptor
  const maxPaths = Math.max(
    1,
    Math.min(
      args.limit,
      descriptor?.maxPagePaths ?? WORKSPACE_PATH_SEARCH_LOCAL_EXPLORER_MAX_PAGE_PATHS
    )
  )
  const maxSerializedBytes =
    descriptor?.maxPageSerializedBytes ??
    RELAY_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR.maxPageSerializedBytes
  const correlationId = args.correlationId ?? createBrowserUuid()
  const request = createRequest({
    query: query.query,
    correlationId,
    scope,
    worktree: args.worktree,
    incarnationId: capability.incarnationId,
    maxPaths,
    maxSerializedBytes
  })
  if (!descriptor || !supportsScope(descriptor, scope)) {
    if (!scope.includeIgnoredFiles) {
      return toFilePathSearchResult(
        createPartialWorkspacePathSearchResponse({
          requestIdentity: request.identity,
          paths: [],
          generationId: `web-legacy-${correlationId}`,
          degradationReason: 'classification-pending'
        })
      )
    }
    const listed = await callRuntimeResult<RuntimeFileListResult>(
      'files.list',
      { worktree: toRuntimeWorktreeSelector(args.worktree.id) },
      15_000,
      args.signal
    )
    const excludePrefixes = buildExcludePathPrefixes(args.worktree.path, args.excludePaths)
    const matcher = new NameFilterPathMatcher(query.query, maxPaths)
    for (const entry of listed.files) {
      if (
        shouldExcludeQuickOpenRelPath(entry.relativePath, excludePrefixes) ||
        (scope.includeDotfiles === false && containsDotfileSegment(entry.relativePath))
      ) {
        continue
      }
      matcher.consider(entry.relativePath)
    }
    return toFilePathSearchResult(
      createPartialWorkspacePathSearchResponse({
        requestIdentity: request.identity,
        paths: matcher.result().paths,
        generationId: `web-legacy-${correlationId}`,
        degradationReason: 'unsupported'
      })
    )
  }

  const response = await callRuntimeResult<unknown>(
    'files.searchPaths',
    {
      worktree: toRuntimeWorktreeSelector(args.worktree.id),
      query: query.query,
      limit: maxPaths,
      excludePaths: args.excludePaths,
      mode: 'name-filter',
      scope,
      maxPageSerializedBytes: maxSerializedBytes,
      correlationId
    },
    30_000,
    args.signal
  )
  return toFilePathSearchResult(parseWorkspacePathSearchWireResponse(response, request.identity))
}

function createScope(
  rootPath: string,
  args: {
    excludePaths?: string[]
    includeDotfiles?: boolean
    includeIgnoredFiles?: boolean
  }
): WorkspacePathSearchScopeDescriptor {
  const includeIgnoredFiles = args.includeIgnoredFiles ?? true
  return {
    pathSet: includeIgnoredFiles ? 'all' : 'included',
    includeDotfiles: args.includeDotfiles ?? true,
    includeIgnoredFiles,
    excludePathSegments: buildExcludePathPrefixes(rootPath, args.excludePaths).map((path) =>
      path.split('/')
    )
  }
}

function createRequest(args: {
  query: string
  correlationId: string
  scope: WorkspacePathSearchScopeDescriptor
  worktree: { id: string; path: string }
  incarnationId: string
  maxPaths: number
  maxSerializedBytes: number
}): WorkspacePathSearchRequest {
  const identity: WorkspacePathSearchFenceIdentity = {
    query: args.query,
    consumer: { consumerId: args.correlationId, sequence: 1 },
    owner: {
      executionHost: { provider: 'runtime', incarnationId: args.incarnationId },
      authorizedCanonicalRoot: args.worktree.path
    },
    generationId: null,
    mode: 'name-filter',
    scope: args.scope,
    pageBudget: { maxPaths: args.maxPaths, maxSerializedBytes: args.maxSerializedBytes }
  }
  return { identity, correlationId: args.correlationId }
}

function supportsScope(
  descriptor: NonNullable<
    Awaited<ReturnType<typeof readWebWorkspacePathSearchCapability>>
  >['descriptor'],
  scope: WorkspacePathSearchScopeDescriptor
): boolean {
  return (
    descriptor !== null &&
    descriptor.matcherVersion === 1 &&
    descriptor.supportedScopes.includes(scope.pathSet) &&
    (scope.includeDotfiles || descriptor.supportsDotfileVisibility) &&
    descriptor.supportsIgnoredFileVisibility &&
    (scope.excludePathSegments.length === 0 || descriptor.supportsExcludePathSegments)
  )
}

function containsDotfileSegment(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.'))
}
