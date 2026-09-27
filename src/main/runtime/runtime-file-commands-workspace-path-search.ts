import { randomUUID } from 'node:crypto'
import { NameFilterPathMatcher } from '../../shared/quick-open-path-search'
import { QUICK_OPEN_LISTING_MAX_RESULTS } from '../../shared/quick-open-listing-limits'
import {
  buildExcludePathPrefixes,
  shouldExcludeQuickOpenRelPath
} from '../../shared/quick-open-filter'
import {
  WORKSPACE_PATH_SEARCH_TRANSPORT_BYTE_CEILINGS,
  validateWorkspacePathSearchQuery,
  type WorkspacePathSearchRequest,
  type WorkspacePathSearchResponse,
  type WorkspacePathSearchScopeDescriptor
} from '../../shared/workspace-path-search-contract'
import { RUNTIME_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR } from '../../shared/workspace-path-search-capability'
import { limitWorkspacePathSearchRequestToCapability } from '../../shared/workspace-path-search-request-budget'
import {
  createCompleteWorkspacePathSearchResponse,
  createPartialWorkspacePathSearchResponse
} from '../../shared/workspace-path-search-response'
import { limitWorkspacePathSearchResponseBySerializedBytes } from '../../shared/workspace-path-search-transport-budget'
import { searchQuickOpenFilePaths } from '../ipc/filesystem-search-file-paths'
import { runtimeFileRouteForTarget } from './runtime-file-command-target'
import type { IFilesystemProvider } from '../providers/types'
import { parseWslPath } from '../wsl'
import { RuntimeFileCommandsWithSearchLocalRuntimeFiles } from './runtime-file-commands-search-local-runtime-files'

type WorkspacePathSearchOptions = {
  query: string
  limit: number
  excludePaths?: string[]
  scope: WorkspacePathSearchScopeDescriptor
  maxPageSerializedBytes: number
  correlationId?: string
  signal?: AbortSignal
  maxContentBytes?: number
}

export class RuntimeFileCommandsWithWorkspacePathSearch extends RuntimeFileCommandsWithSearchLocalRuntimeFiles {
  async searchWorkspacePathNameFilter(
    worktreeSelector: string,
    options: WorkspacePathSearchOptions
  ): Promise<WorkspacePathSearchResponse> {
    const query = validateWorkspacePathSearchQuery(options.query, 'remote')
    if (!query.ok || !query.query.trim()) {
      throw new Error('Invalid remote workspace path search query')
    }
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const route = runtimeFileRouteForTarget(target)
    const rootPath = target.worktree.path
    const descriptor = RUNTIME_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR
    const limit = Math.min(options.limit, descriptor.maxPagePaths)
    const maxPageSerializedBytes = Math.min(
      options.maxPageSerializedBytes,
      descriptor.maxPageSerializedBytes
    )
    const request = createWorkspacePathSearchRequest({
      rootPath,
      runtimeId: this.host.getRuntimeId(),
      route: route.kind === 'ssh' ? route : null,
      query: query.query,
      limit,
      maxPageSerializedBytes,
      excludePaths: options.excludePaths,
      scope: options.scope,
      correlationId: options.correlationId
    })

    let response: WorkspacePathSearchResponse
    if (route.kind === 'ssh') {
      if (!route.provider) {
        throw new Error('Remote filesystem is unavailable for name-filter search')
      }
      const remoteCapability = await route.provider.workspacePathSearchCapability?.({
        signal: options.signal
      })
      const remoteRequest = remoteCapability
        ? limitWorkspacePathSearchRequestToCapability(request, remoteCapability)
        : request
      const remoteResponse = await route.provider.searchWorkspacePathNameFilter?.(
        rootPath,
        remoteRequest,
        { signal: options.signal }
      )
      response =
        remoteResponse ??
        (await this.searchRemoteLegacyWorkspacePaths(route.provider, rootPath, request, options))
    } else {
      const result = await searchQuickOpenFilePaths(rootPath, this.host.requireStore(), {
        query: query.query,
        limit,
        excludePaths: options.excludePaths,
        signal: options.signal,
        mode: 'name-filter',
        includeIgnoredFiles: options.scope.includeIgnoredFiles,
        includeDotfiles: options.scope.includeDotfiles
      })
      response = createCompleteWorkspacePathSearchResponse({
        requestIdentity: request.identity,
        paths: result.paths,
        totalCount: result.totalCount,
        generationId: `runtime-live-${request.correlationId}`
      })
    }

    return limitWorkspacePathSearchResponseBySerializedBytes(response, {
      maxPageSerializedBytes: Math.min(
        request.identity.pageBudget.maxSerializedBytes,
        options.maxContentBytes ?? descriptor.maxPageSerializedBytes
      ),
      transportByteCeilings: [
        WORKSPACE_PATH_SEARCH_TRANSPORT_BYTE_CEILINGS.remoteRuntimeJson,
        WORKSPACE_PATH_SEARCH_TRANSPORT_BYTE_CEILINGS.relayFramePayload
      ],
      envelopeHeadroomBytes: 4 * 1024
    })
  }

  private async searchRemoteLegacyWorkspacePaths(
    provider: IFilesystemProvider,
    rootPath: string,
    request: WorkspacePathSearchRequest,
    options: WorkspacePathSearchOptions
  ): Promise<WorkspacePathSearchResponse> {
    if (!request.identity.scope.includeIgnoredFiles) {
      return createPartialWorkspacePathSearchResponse({
        requestIdentity: request.identity,
        paths: [],
        generationId: `runtime-legacy-${request.correlationId}`,
        degradationReason: 'classification-pending'
      })
    }
    const excludePathPrefixes = buildExcludePathPrefixes(rootPath, options.excludePaths)
    const listed = await provider.listFiles(rootPath, {
      excludePaths: options.excludePaths,
      maxResults: QUICK_OPEN_LISTING_MAX_RESULTS,
      signal: options.signal
    })
    const matcher = new NameFilterPathMatcher(
      request.identity.query,
      request.identity.pageBudget.maxPaths
    )
    for (const path of listed) {
      if (
        shouldExcludeQuickOpenRelPath(path, excludePathPrefixes) ||
        (!request.identity.scope.includeDotfiles && containsDotfileSegment(path))
      ) {
        continue
      }
      matcher.consider(path)
    }
    return createPartialWorkspacePathSearchResponse({
      requestIdentity: request.identity,
      paths: request.identity.scope.includeIgnoredFiles ? matcher.result().paths : [],
      generationId: `runtime-legacy-${request.correlationId}`,
      degradationReason: request.identity.scope.includeIgnoredFiles
        ? 'unsupported'
        : 'classification-pending'
    })
  }
}

function createWorkspacePathSearchRequest(args: {
  rootPath: string
  runtimeId: string
  route: { connectionId: string } | null
  query: string
  limit: number
  maxPageSerializedBytes: number
  excludePaths?: string[]
  scope: WorkspacePathSearchScopeDescriptor
  correlationId?: string
}): WorkspacePathSearchRequest {
  const expectedScope: WorkspacePathSearchScopeDescriptor = {
    pathSet: args.scope.includeIgnoredFiles ? 'all' : 'included',
    includeDotfiles: args.scope.includeDotfiles,
    includeIgnoredFiles: args.scope.includeIgnoredFiles,
    excludePathSegments: buildExcludePathPrefixes(args.rootPath, args.excludePaths).map((path) =>
      path.split('/')
    )
  }
  if (JSON.stringify(expectedScope) !== JSON.stringify(args.scope)) {
    throw new Error('Workspace path search scope does not match authorized exclusions')
  }
  const scope = expectedScope
  const correlationId = args.correlationId ?? randomUUID()
  const wslDistro = parseWslPath(args.rootPath)?.distro
  const identity = {
    query: args.query,
    consumer: { consumerId: correlationId, sequence: 1 },
    owner: {
      executionHost: {
        provider: args.route ? 'ssh' : wslDistro ? 'wsl' : 'runtime',
        incarnationId:
          args.route?.connectionId ?? `${args.runtimeId}${wslDistro ? `:${wslDistro}` : ''}`
      },
      authorizedCanonicalRoot: args.rootPath
    },
    generationId: null,
    mode: 'name-filter' as const,
    scope,
    pageBudget: { maxPaths: args.limit, maxSerializedBytes: args.maxPageSerializedBytes }
  }
  return { identity, correlationId }
}

function containsDotfileSegment(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.'))
}
