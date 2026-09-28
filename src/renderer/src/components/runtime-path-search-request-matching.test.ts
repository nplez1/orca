import { describe, expect, it } from 'vitest'
import type { WorkspacePathSearchFenceIdentity } from '../../../shared/workspace-path-search-contract'
import { createCompleteWorkspacePathSearchResponse } from '../../../shared/workspace-path-search-response'
import { responseMatchesRuntimePathSearchRequest } from './runtime-path-search-request-matching'

const identity: WorkspacePathSearchFenceIdentity = {
  query: 'package.',
  consumer: { consumerId: 'consumer-1', sequence: 2 },
  owner: {
    executionHost: { provider: 'local', incarnationId: '32984' },
    authorizedCanonicalRoot: '/repo'
  },
  generationId: null,
  mode: 'name-filter',
  scope: {
    pathSet: 'all',
    includeDotfiles: true,
    includeIgnoredFiles: true,
    excludePathSegments: []
  },
  pageBudget: { maxPaths: 5_000, maxSerializedBytes: 16_777_216 }
}

const request = {
  query: identity.query,
  correlationId: 'correlation-1',
  consumer: identity.consumer,
  rootPath: identity.owner.authorizedCanonicalRoot,
  operationOwner: { kind: 'local' as const },
  scope: identity.scope,
  maxPaths: identity.pageBudget.maxPaths,
  maxSerializedBytes: identity.pageBudget.maxSerializedBytes
}

function responseFor(
  requestIdentity: WorkspacePathSearchFenceIdentity
): ReturnType<typeof createCompleteWorkspacePathSearchResponse> {
  return createCompleteWorkspacePathSearchResponse({
    requestIdentity,
    paths: ['package.json'],
    totalCount: 1,
    generationId: 'live-1'
  })
}

describe('responseMatchesRuntimePathSearchRequest', () => {
  // Why: a rejected response is reported as "the file search response did not match the current
  // workspace request", so a producer that cannot satisfy this fence shows the user no rows at all.
  it('accepts a response that echoes the request identity verbatim', () => {
    expect(responseMatchesRuntimePathSearchRequest(responseFor(identity), request)).toBe(true)
  })

  it('rejects a response for a different scope', () => {
    const otherScope = { ...identity, scope: { ...identity.scope, includeDotfiles: false } }
    expect(responseMatchesRuntimePathSearchRequest(responseFor(otherScope), request)).toBe(false)
  })

  it('rejects a response another consumer asked for', () => {
    const otherConsumer = {
      ...identity,
      consumer: { consumerId: 'consumer-2', sequence: 3 }
    }
    expect(responseMatchesRuntimePathSearchRequest(responseFor(otherConsumer), request)).toBe(false)
  })
})
