import { buildExcludePathPrefixes } from '../../../shared/quick-open-filter'
import {
  WORKSPACE_PATH_SEARCH_TRANSPORT_BYTE_CEILINGS,
  type WorkspacePathSearchConsumerSequence,
  type WorkspacePathSearchFenceIdentity,
  type WorkspacePathSearchResponse,
  type WorkspacePathSearchScopeDescriptor
} from '../../../shared/workspace-path-search-contract'
import type { FileExplorerOperationOwner } from '@/components/right-sidebar/file-explorer-types'

export const MAX_WORKSPACE_PATH_SEARCH_PAGE_BYTES = Math.max(
  ...Object.values(WORKSPACE_PATH_SEARCH_TRANSPORT_BYTE_CEILINGS)
)

export function isExactCompleteSearchCount(response: WorkspacePathSearchResponse): boolean {
  return (
    response.state.coverage === 'complete' &&
    response.state.freshness === 'no-known-gap' &&
    response.state.countProvenance === 'exact-snapshot' &&
    response.count.provenance === 'exact-snapshot'
  )
}

export function buildNameFilterScope(args: {
  rootPath: string
  excludePaths?: string[]
  includeDotfiles: boolean
  includeIgnoredFiles: boolean
}): WorkspacePathSearchScopeDescriptor {
  return {
    pathSet: args.includeIgnoredFiles ? 'all' : 'included',
    includeDotfiles: args.includeDotfiles,
    includeIgnoredFiles: args.includeIgnoredFiles,
    excludePathSegments: buildExcludePathPrefixes(args.rootPath, args.excludePaths).map((path) =>
      path.split('/')
    )
  }
}

export function responseMatchesRuntimePathSearchRequest(
  response: WorkspacePathSearchResponse,
  request: {
    query: string
    correlationId: string
    consumer: WorkspacePathSearchConsumerSequence
    rootPath: string
    operationOwner: FileExplorerOperationOwner
    scope: WorkspacePathSearchScopeDescriptor
    maxPaths: number
    maxSerializedBytes: number
  }
): boolean {
  const identity: WorkspacePathSearchFenceIdentity = response.requestIdentity
  const ownerProviderMatches =
    request.operationOwner.kind === 'ssh'
      ? identity.owner.executionHost.provider === 'ssh' &&
        identity.owner.executionHost.incarnationId === request.operationOwner.connectionId
      : request.operationOwner.kind === 'runtime'
        ? identity.owner.executionHost.provider === 'runtime'
        : request.operationOwner.kind === 'local'
          ? identity.owner.executionHost.provider === 'local' ||
            identity.owner.executionHost.provider === 'wsl'
          : false
  const consumerMatches =
    request.operationOwner.kind === 'local'
      ? identity.consumer.consumerId === request.consumer.consumerId &&
        identity.consumer.sequence === request.consumer.sequence
      : identity.consumer.consumerId === request.correlationId && identity.consumer.sequence === 1
  return (
    identity.query === request.query &&
    consumerMatches &&
    identity.mode === 'name-filter' &&
    identity.generationId === null &&
    ownerProviderMatches &&
    identity.owner.authorizedCanonicalRoot === request.rootPath &&
    JSON.stringify(identity.scope) === JSON.stringify(request.scope) &&
    response.scopeFingerprint === JSON.stringify(request.scope) &&
    response.generationId.length > 0 &&
    response.scopeRuleVersion.length > 0 &&
    Number.isSafeInteger(identity.pageBudget.maxPaths) &&
    identity.pageBudget.maxPaths > 0 &&
    identity.pageBudget.maxPaths <= request.maxPaths &&
    Number.isSafeInteger(identity.pageBudget.maxSerializedBytes) &&
    identity.pageBudget.maxSerializedBytes > 0 &&
    identity.pageBudget.maxSerializedBytes <= request.maxSerializedBytes &&
    response.retainedCount === response.rows.length &&
    response.rowClassificationFlags.length === response.rows.length
  )
}
