import { randomUUID } from 'node:crypto'
import { buildExcludePathPrefixes } from '../../shared/quick-open-filter'
import {
  WORKSPACE_PATH_SEARCH_TRANSPORT_BYTE_CEILINGS,
  validateWorkspacePathSearchQuery,
  type WorkspacePathSearchRequest,
  type WorkspacePathSearchResponse,
  type WorkspacePathSearchScopeDescriptor
} from '../../shared/workspace-path-search-contract'
import { RUNTIME_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR } from '../../shared/workspace-path-search-capability'
import {
  createCompleteWorkspacePathSearchResponse,
  createPartialWorkspacePathSearchResponse
} from '../../shared/workspace-path-search-response'
import { limitWorkspacePathSearchResponseBySerializedBytes } from '../../shared/workspace-path-search-transport-budget'
import { searchQuickOpenFilePaths } from '../ipc/filesystem/filesystem-search-file-paths'
import { parseWslPath } from '../wsl'
import { runtimeFileRouteForTarget } from './files/file-target'
import { RuntimeFileSearch } from './files/search/file-search'
import type { RuntimeFileCommandHost } from './files/file-command-host'

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

/**
 * The runtime's answer to a negotiated `files.searchPaths` name-filter request.
 *
 * Why the SSH half is gone: upstream deleted the relay-era filesystem dispatch this used to reach
 * (`IFilesystemProvider.searchWorkspacePathNameFilter` and its capability probe), and SSH hosts are
 * served by orcad. An SSH route answers a partial/unsupported response so the client degrades the
 * way it already does for an unsupported host, instead of failing the search outright. Every other
 * route searches the runtime's own tree, which is the half the desktop's own IPC handler does not
 * cover: the web client and paired desktop clients come through here.
 */
export class RuntimeFileCommandsWithWorkspacePathSearch extends RuntimeFileSearch {
  constructor(protected readonly workspaceHost: RuntimeFileCommandHost) {
    super(workspaceHost)
  }

  async searchWorkspacePathNameFilter(
    worktreeSelector: string,
    options: WorkspacePathSearchOptions
  ): Promise<WorkspacePathSearchResponse> {
    const query = validateWorkspacePathSearchQuery(options.query, 'remote')
    if (!query.ok || !query.query.trim()) {
      throw new Error('Invalid remote workspace path search query')
    }
    const target = await this.workspaceHost.resolveRuntimeFileTarget(worktreeSelector)
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
      runtimeId: this.workspaceHost.getRuntimeId(),
      route: route.kind === 'ssh' ? route : null,
      query: query.query,
      limit,
      maxPageSerializedBytes,
      excludePaths: options.excludePaths,
      scope: options.scope,
      correlationId: options.correlationId
    })

    const response =
      route.kind === 'ssh'
        ? createPartialWorkspacePathSearchResponse({
            requestIdentity: request.identity,
            paths: [],
            generationId: `runtime-ssh-not-served-${request.correlationId}`,
            degradationReason: 'unsupported'
          })
        : await this.searchLocalWorkspacePaths(rootPath, request, options)

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

  private async searchLocalWorkspacePaths(
    rootPath: string,
    request: WorkspacePathSearchRequest,
    options: WorkspacePathSearchOptions
  ): Promise<WorkspacePathSearchResponse> {
    const result = await searchQuickOpenFilePaths(rootPath, this.workspaceHost.requireStore(), {
      query: request.identity.query,
      limit: request.identity.pageBudget.maxPaths,
      excludePaths: options.excludePaths,
      signal: options.signal,
      mode: 'name-filter',
      includeIgnoredFiles: request.identity.scope.includeIgnoredFiles,
      includeDotfiles: request.identity.scope.includeDotfiles
    })
    return createCompleteWorkspacePathSearchResponse({
      requestIdentity: request.identity,
      paths: result.paths,
      totalCount: result.totalCount,
      generationId: `runtime-live-${request.correlationId}`
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
