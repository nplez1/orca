import { describe, expect, it } from 'vitest'
import type { WorkspacePathSearchResponse } from './workspace-path-search-contract'
import { limitWorkspacePathSearchResponseBySerializedBytes } from './workspace-path-search-transport-budget'
import { parseWorkspacePathSearchWireResponse } from './workspace-path-search-wire-response'

const response = {
  requestIdentity: {
    query: 'x',
    consumer: { consumerId: 'consumer-1', sequence: 4 },
    owner: {
      executionHost: { provider: 'runtime', incarnationId: 'runtime-1' },
      authorizedCanonicalRoot: '/repo'
    },
    generationId: null,
    mode: 'name-filter',
    scope: {
      pathSet: 'included',
      includeDotfiles: true,
      includeIgnoredFiles: false,
      excludePathSegments: []
    },
    pageBudget: { maxPaths: 3, maxSerializedBytes: 10_000 }
  },
  generationId: 'generation-1',
  scopeFingerprint:
    '{"pathSet":"included","includeDotfiles":true,"includeIgnoredFiles":false,"excludePathSegments":[]}',
  scopeRuleVersion: 'relay-live-scan-v1',
  rows: [
    { relativePath: 'src/quote"\\\u0001.ts' },
    { relativePath: `src/${'長'.repeat(40)}.ts` },
    { relativePath: 'src/last.ts' }
  ],
  rowClassificationFlags: [0, 0, 0],
  retainedCount: 3,
  state: {
    coverage: 'complete',
    freshness: 'no-known-gap',
    countProvenance: 'exact-snapshot',
    searchComplete: true
  },
  count: { value: 3, provenance: 'exact-snapshot' }
} as const satisfies WorkspacePathSearchResponse

describe('workspace path search transport budget', () => {
  it('trims once by escaped serialized bytes while preserving exact totals and decodable JSON', () => {
    const headroom = 256
    const oneRow = {
      ...response,
      rows: [response.rows[0]],
      rowClassificationFlags: [0],
      retainedCount: 1
    }
    const pageBudget = Buffer.byteLength(JSON.stringify(oneRow), 'utf8')
    const budget = pageBudget + headroom

    const bounded = limitWorkspacePathSearchResponseBySerializedBytes(response, {
      maxPageSerializedBytes: pageBudget,
      transportByteCeilings: [budget + 1_000, budget + 2_000],
      envelopeHeadroomBytes: headroom
    })
    const serialized = JSON.stringify(bounded)

    expect(JSON.parse(serialized)).toMatchObject({
      retainedCount: 1,
      count: { value: 3, provenance: 'exact-snapshot' },
      state: { coverage: 'complete', countProvenance: 'exact-snapshot' }
    })
    expect(Buffer.byteLength(serialized, 'utf8') + headroom).toBeLessThanOrEqual(budget)
    expect(serialized).toContain('\\u0001')
    expect(
      parseWorkspacePathSearchWireResponse(JSON.parse(serialized), response.requestIdentity)
    ).toMatchObject({
      retainedCount: 1,
      count: { value: 3, provenance: 'exact-snapshot' }
    })
  })
})
