import { z } from 'zod'
import { MAX_MESSAGE_SIZE } from './protocol'
import type { RequestContext } from './dispatcher'
import { expandTilde } from './context'
import { searchNameFilterPathsWithRg } from './fs-handler-name-filter-scan'
import {
  createCompleteWorkspacePathSearchResponse,
  createPartialWorkspacePathSearchResponse
} from '../shared/workspace-path-search-response'
import { limitWorkspacePathSearchResponseBySerializedBytes } from '../shared/workspace-path-search-transport-budget'
import {
  validateWorkspacePathSearchQuery,
  type WorkspacePathSearchRequest
} from '../shared/workspace-path-search-contract'
import { RELAY_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR } from '../shared/workspace-path-search-capability'

let relaySearchGeneration = 0

export async function searchRelayNameFilterPaths(
  params: Record<string, unknown>,
  context: RequestContext
) {
  if (typeof params.rootPath !== 'string' || params.rootPath.length === 0) {
    throw new Error('Workspace path search root is missing')
  }
  const rootPath = expandTilde(params.rootPath)
  const request = readWorkspacePathSearchRequest(params.request)
  const query = validateWorkspacePathSearchQuery(request.identity.query, 'remote')
  if (!query.ok || !query.query.trim()) {
    throw new Error('Invalid remote workspace path search query')
  }

  const identity = request.identity
  const descriptor = RELAY_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR
  if (
    identity.mode !== 'name-filter' ||
    identity.scope.pathSet !== (identity.scope.includeIgnoredFiles ? 'all' : 'included') ||
    identity.pageBudget.maxPaths > descriptor.maxPagePaths ||
    identity.pageBudget.maxSerializedBytes > descriptor.maxPageSerializedBytes ||
    !descriptor.supportedScopes.includes(identity.scope.pathSet)
  ) {
    throw new Error('Workspace path search request exceeds the negotiated capability')
  }

  const matches = await searchNameFilterPathsWithRg(rootPath, identity, context.signal)
  const generationId = `relay-live-${++relaySearchGeneration}`
  const response = matches.complete
    ? createCompleteWorkspacePathSearchResponse({
        requestIdentity: identity,
        paths: matches.paths,
        totalCount: matches.totalCount,
        generationId
      })
    : createPartialWorkspacePathSearchResponse({
        requestIdentity: identity,
        paths: matches.paths,
        generationId,
        degradationReason: 'interrupted'
      })
  return limitWorkspacePathSearchResponseBySerializedBytes(response, {
    maxPageSerializedBytes: identity.pageBudget.maxSerializedBytes,
    transportByteCeilings: [MAX_MESSAGE_SIZE],
    envelopeHeadroomBytes: 64 * 1024
  })
}

const WorkspacePathSearchRequestSchema = z.object({
  identity: z.object({
    query: z.string(),
    consumer: z.object({ consumerId: z.string().min(1), sequence: z.number().int().nonnegative() }),
    owner: z.object({
      executionHost: z.object({ provider: z.string(), incarnationId: z.string() }),
      authorizedCanonicalRoot: z.string()
    }),
    generationId: z.string().nullable(),
    mode: z.literal('name-filter'),
    scope: z.object({
      pathSet: z.enum(['included', 'all']),
      includeDotfiles: z.boolean(),
      includeIgnoredFiles: z.boolean(),
      excludePathSegments: z.array(z.array(z.string()))
    }),
    pageBudget: z.object({
      maxPaths: z.number().int().positive(),
      maxSerializedBytes: z.number().int().positive()
    })
  }),
  correlationId: z.string().min(1)
})

function readWorkspacePathSearchRequest(value: unknown): WorkspacePathSearchRequest {
  return WorkspacePathSearchRequestSchema.parse(value)
}
