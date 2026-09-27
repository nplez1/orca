import { describe, expect, it } from 'vitest'
import { QUICK_OPEN_LISTING_MAX_RESULTS } from './quick-open-listing-limits'
import {
  WORKSPACE_PATH_SEARCH_LOCAL_EXPLORER_MAX_PAGE_PATHS,
  WORKSPACE_PATH_SEARCH_LEGACY_RUNTIME_MAX_PAGE_PATHS,
  WORKSPACE_PATH_SEARCH_LIMITS,
  validateWorkspacePathSearchQuery,
  type WorkspacePathSearchResponse,
  type WorkspacePathSearchResultState
} from './workspace-path-search-contract'

describe('workspace path search contract', () => {
  it('keeps per-surface page and query limits distinct from browse listing limits', () => {
    expect(WORKSPACE_PATH_SEARCH_LEGACY_RUNTIME_MAX_PAGE_PATHS).toBe(32)
    expect(WORKSPACE_PATH_SEARCH_LOCAL_EXPLORER_MAX_PAGE_PATHS).toBe(5_000)
    expect(QUICK_OPEN_LISTING_MAX_RESULTS).toBe(20_001)
    expect(WORKSPACE_PATH_SEARCH_LIMITS.localQueryMaxUtf8Bytes).toBe(2 * 1024)
    expect(WORKSPACE_PATH_SEARCH_LIMITS.remoteQueryMaxCodeUnits).toBe(256)
  })

  it('tokenizes only after accepting a query inside the UTF-8 byte limit', () => {
    const result = validateWorkspacePathSearchQuery('  Drover\teve ')
    expect(result).toEqual({
      ok: true,
      query: '  Drover\teve ',
      tokens: ['drover', 'eve'],
      utf8ByteLength: 13
    })
    expect(validateWorkspacePathSearchQuery('x'.repeat(2 * 1024))).toMatchObject({ ok: true })
    expect(validateWorkspacePathSearchQuery('x'.repeat(2 * 1024 + 1))).toMatchObject({
      ok: false,
      reason: 'utf8-byte-limit'
    })
    expect(validateWorkspacePathSearchQuery('漢'.repeat(683))).toMatchObject({
      ok: false,
      reason: 'utf8-byte-limit'
    })
  })

  it('enforces the remote code-unit limit and rejects non-string input', () => {
    expect(validateWorkspacePathSearchQuery('x'.repeat(257), 'remote')).toMatchObject({
      ok: false,
      reason: 'remote-code-unit-limit'
    })
    expect(validateWorkspacePathSearchQuery(null)).toMatchObject({
      ok: false,
      reason: 'not-a-string'
    })
  })

  it('allows exact current-empty and non-authoritative last-known responses to differ by state', () => {
    const exactEmpty: WorkspacePathSearchResponse = {
      requestIdentity: {
        query: 'missing',
        consumer: { consumerId: 'explorer-1', sequence: 3 },
        owner: {
          executionHost: { provider: 'local', incarnationId: 'host-1' },
          authorizedCanonicalRoot: '/workspace'
        },
        generationId: null,
        mode: 'name-filter',
        scope: {
          pathSet: 'included',
          includeDotfiles: false,
          includeIgnoredFiles: false,
          excludePathSegments: []
        },
        pageBudget: { maxPaths: 5_000, maxSerializedBytes: 1_000_000 }
      },
      generationId: 'generation-7',
      scopeFingerprint: 'scope-1',
      scopeRuleVersion: 'rules-1',
      state: {
        coverage: 'complete',
        freshness: 'no-known-gap',
        countProvenance: 'exact-snapshot',
        searchComplete: true
      },
      count: { value: 0, provenance: 'exact-snapshot' },
      rows: [],
      rowClassificationFlags: [],
      retainedCount: 0
    }
    expect(exactEmpty.state.countProvenance).toBe('exact-snapshot')

    const lastKnown: WorkspacePathSearchResponse = {
      ...exactEmpty,
      state: {
        coverage: 'complete',
        freshness: 'dirty',
        countProvenance: 'last-known',
        searchComplete: true
      },
      count: { value: 0, provenance: 'last-known' },
      degradationReason: 'expired'
    }
    expect(lastKnown.state.freshness).toBe('dirty')
    expect(lastKnown.count.provenance).toBe('last-known')

    // @ts-expect-error Dirty snapshots cannot authorize exact-snapshot empty-state claims.
    const invalidDirtyExactState: WorkspacePathSearchResultState = {
      coverage: 'complete',
      freshness: 'dirty',
      countProvenance: 'exact-snapshot',
      searchComplete: true
    }
    expect(invalidDirtyExactState.countProvenance).toBe('exact-snapshot')
  })
})
