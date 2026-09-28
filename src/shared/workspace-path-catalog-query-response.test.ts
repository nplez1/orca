import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_PATH_CATALOG_SCOPE_RULE_VERSION,
  type WorkspacePathCatalogMetadata
} from './workspace-path-catalog'
import { buildWorkspacePathSearchResponse } from './workspace-path-catalog-query-response'
import type { WorkspacePathSearchFenceIdentity } from './workspace-path-search-contract'
import { parseWorkspacePathSearchWireResponse } from './workspace-path-search-wire-response'

const identity: WorkspacePathSearchFenceIdentity = {
  query: 'package.',
  consumer: { consumerId: 'consumer-1', sequence: 1 },
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

const metadata: WorkspacePathCatalogMetadata = {
  foldLocale: 'en',
  foldVersion: 'fold-v1',
  scopeRuleVersion: WORKSPACE_PATH_CATALOG_SCOPE_RULE_VERSION,
  includedComplete: true,
  allComplete: true,
  classificationComplete: true,
  coverageExcludePathSegments: [],
  freshness: 'no-known-gap'
}

describe('workspace path catalog query response', () => {
  // Why: this is the only response producer assembled away from the wire parser, so nothing else
  // catches it fingerprinting the scope in a form the fence cannot recompute.
  it('survives the wire fence the renderer and every remote client apply', () => {
    const response = buildWorkspacePathSearchResponse({
      identity,
      generationId: 'catalog-generation:overlay',
      metadata,
      prefixes: [],
      rows: [{ relativePath: 'package.json' }],
      rowClassificationFlags: [0],
      matches: 1
    })

    expect(response.scopeFingerprint).toBe(JSON.stringify(identity.scope))
    expect(response.requestIdentity).toEqual(identity)
    expect(parseWorkspacePathSearchWireResponse(response, identity)).toMatchObject({
      generationId: 'catalog-generation:overlay',
      scopeFingerprint: JSON.stringify(identity.scope),
      retainedCount: 1
    })
  })
})
