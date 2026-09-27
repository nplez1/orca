import type { FilePathSearchResult } from '../../../shared/file-path-search-result'
import {
  WORKSPACE_PATH_SEARCH_LOCAL_EXPLORER_MAX_PAGE_PATHS,
  WORKSPACE_PATH_SEARCH_TRANSPORT_BYTE_CEILINGS,
  validateWorkspacePathSearchQuery,
  type WorkspacePathSearchCapabilityDescriptor,
  type WorkspacePathSearchFenceIdentity,
  type WorkspacePathSearchScopeDescriptor
} from '../../../shared/workspace-path-search-contract'
import { createPartialWorkspacePathSearchResponse } from '../../../shared/workspace-path-search-response'
import { parseWorkspacePathSearchWireResponse } from '../../../shared/workspace-path-search-wire-response'
import { toFilePathSearchResult } from '../../../shared/workspace-path-search-file-result'
import { buildExcludePathPrefixes } from '../../../shared/quick-open-filter'
import type { RuntimeFileOperationArgs } from './runtime-file-client-types'
import type { RuntimeClientTarget } from './runtime-rpc-client'
import { callRuntimeRpc, RuntimeRpcCallError } from './runtime-rpc-client'
import { readRuntimeWorkspacePathSearchCapability } from './runtime-workspace-path-search-capability'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import { searchLegacyQuickOpenInventory } from './runtime-legacy-quick-open-inventory'

export async function searchRuntimeNameFilterPaths(
  context: RuntimeFileOperationArgs,
  target: Extract<RuntimeClientTarget, { kind: 'environment' }>,
  args: {
    query: string
    limit: number
    excludePaths?: string[]
    signal?: AbortSignal
    includeIgnoredFiles?: boolean
    includeDotfiles?: boolean
    correlationId?: string
  }
): Promise<FilePathSearchResult> {
  const validated = validateWorkspacePathSearchQuery(args.query, 'remote')
  if (!validated.ok || !validated.query.trim()) {
    throw new Error('Remote filename filter query is too large or invalid')
  }
  if (!context.worktreeId) {
    throw new Error('Remote filename filter workspace is unavailable')
  }
  const worktreeSelector = toRuntimeWorktreeSelector(context.worktreeId)
  const capability = await readRuntimeWorkspacePathSearchCapability(target.environmentId)
  const scope = createRuntimeNameFilterScope(context.worktreePath, args)
  const descriptor = capability?.descriptor ?? null
  const limit = Math.max(
    1,
    Math.min(
      args.limit,
      descriptor?.maxPagePaths ?? WORKSPACE_PATH_SEARCH_LOCAL_EXPLORER_MAX_PAGE_PATHS
    )
  )
  const correlationId = args.correlationId ?? createBrowserUuid()
  const identity = createRuntimeNameFilterIdentity({
    query: validated.query,
    correlationId,
    rootPath: context.worktreePath ?? '',
    incarnationId: capability?.incarnationId ?? `environment:${target.environmentId}`,
    scope,
    maxPaths: limit,
    maxSerializedBytes:
      descriptor?.maxPageSerializedBytes ??
      WORKSPACE_PATH_SEARCH_TRANSPORT_BYTE_CEILINGS.remoteRpcContent
  })

  if (!capability || !descriptor || !supportsWorkspacePathScope(descriptor, scope)) {
    const paths = scope.includeIgnoredFiles
      ? (
          await searchLegacyQuickOpenInventory({
            target,
            worktreeSelector,
            query: validated.query,
            limit,
            worktreePath: context.worktreePath,
            excludePaths: args.excludePaths,
            signal: args.signal,
            mode: 'name-filter'
          })
        ).files
      : []
    const scopedPaths =
      scope.includeDotfiles || paths.length === 0
        ? paths
        : paths.filter((path) => !containsDotfileSegment(path))
    return toFilePathSearchResult(
      createPartialWorkspacePathSearchResponse({
        requestIdentity: identity,
        paths: scopedPaths,
        generationId: `runtime-legacy-${correlationId}`,
        degradationReason: scope.includeIgnoredFiles ? 'unsupported' : 'classification-pending'
      })
    )
  }

  let wireResult: unknown
  try {
    wireResult = await callRuntimeRpc<unknown>(
      target,
      'files.searchPaths',
      {
        worktree: worktreeSelector,
        query: validated.query,
        limit,
        excludePaths: args.excludePaths,
        mode: 'name-filter',
        scope,
        maxPageSerializedBytes: identity.pageBudget.maxSerializedBytes,
        correlationId
      },
      {
        timeoutMs: 30_000,
        expectedEnvironmentRuntimeId: capability.incarnationId,
        ...(args.signal === undefined ? {} : { signal: args.signal })
      }
    )
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      throw new Error(
        'The paired Orca host advertised unsupported filename search. Reconnect or update it.'
      )
    }
    throw error
  }
  return toFilePathSearchResult(parseWorkspacePathSearchWireResponse(wireResult, identity))
}

function containsDotfileSegment(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.'))
}

function createRuntimeNameFilterScope(
  rootPath: string | null | undefined,
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
    excludePathSegments: buildExcludePathPrefixes(rootPath ?? '', args.excludePaths).map((path) =>
      path.split('/')
    )
  }
}

function createRuntimeNameFilterIdentity(args: {
  query: string
  correlationId: string
  rootPath: string
  incarnationId: string
  scope: WorkspacePathSearchScopeDescriptor
  maxPaths: number
  maxSerializedBytes: number
}): WorkspacePathSearchFenceIdentity {
  return {
    query: args.query,
    consumer: { consumerId: args.correlationId, sequence: 1 },
    owner: {
      executionHost: { provider: 'runtime', incarnationId: args.incarnationId },
      authorizedCanonicalRoot: args.rootPath
    },
    generationId: null,
    mode: 'name-filter',
    scope: args.scope,
    pageBudget: { maxPaths: args.maxPaths, maxSerializedBytes: args.maxSerializedBytes }
  }
}

function supportsWorkspacePathScope(
  descriptor: WorkspacePathSearchCapabilityDescriptor,
  scope: WorkspacePathSearchScopeDescriptor
): boolean {
  return (
    descriptor.matcherVersion === 1 &&
    descriptor.supportedScopes.includes(scope.pathSet) &&
    (scope.includeDotfiles || descriptor.supportsDotfileVisibility) &&
    descriptor.supportsIgnoredFileVisibility &&
    (scope.excludePathSegments.length === 0 || descriptor.supportsExcludePathSegments)
  )
}
