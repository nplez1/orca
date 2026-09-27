import { describe, expect, it } from 'vitest'
import type { WorkspacePathSearchResponse } from '../../../../shared/workspace-path-search-contract'
import { getFileExplorerNameFilterEmptyMessageKind } from './file-explorer-name-filter-projection'

describe('getFileExplorerNameFilterEmptyMessageKind', () => {
  const base = { hasNameFilter: true, hasLoadError: false, truncated: false }

  it('claims no match only for a complete listing', () => {
    expect(getFileExplorerNameFilterEmptyMessageKind(base)).toBe('no-match')
  })

  it('reports a partial scan instead of claiming no match', () => {
    // Regression: a truncated listing never scanned the whole workspace, so the
    // pane must not tell the user their file does not exist.
    expect(getFileExplorerNameFilterEmptyMessageKind({ ...base, truncated: true })).toBe(
      'partial-scan'
    )
  })

  it('never claims no match for a bounded provisional page', () => {
    // A restored checkpoint answers from a bounded prefix: coverage is partial and the count is
    // null, so the pane may only say the workspace was not fully searched.
    expect(
      getFileExplorerNameFilterEmptyMessageKind({
        ...base,
        workspacePathSearch: boundedProvisionalPage()
      })
    ).toBe('partial-scan')
  })

  it('blames freshness, not a partial scan, for provisional last-known coverage', () => {
    // A restored generation still covers the snapshot; only freshness is provisional, so the pane
    // reports that it is being brought up to date rather than claiming a scan gap.
    expect(
      getFileExplorerNameFilterEmptyMessageKind({
        ...base,
        workspacePathSearch: {
          ...boundedProvisionalPage(),
          state: {
            coverage: 'complete',
            freshness: 'provisional',
            countProvenance: 'last-known',
            searchComplete: true
          },
          count: { value: 0, provenance: 'last-known' }
        }
      })
    ).toBe('stale')
  })

  it('blames freshness, not a partial scan, when the snapshot covers the scope but is dirty', () => {
    // Regression: the search completed for the snapshot, so "Only part of this workspace was
    // searched" names the wrong reason — the honest state is that the list is being refreshed.
    expect(
      getFileExplorerNameFilterEmptyMessageKind({
        ...base,
        workspacePathSearch: {
          ...boundedProvisionalPage(),
          state: {
            coverage: 'complete',
            freshness: 'dirty',
            countProvenance: 'last-known',
            searchComplete: true
          },
          count: { value: 0, provenance: 'last-known' }
        }
      })
    ).toBe('stale')
  })

  it('shows no filter message when the query is empty or the listing failed', () => {
    expect(getFileExplorerNameFilterEmptyMessageKind({ ...base, hasNameFilter: false })).toBeNull()
    expect(getFileExplorerNameFilterEmptyMessageKind({ ...base, hasLoadError: true })).toBeNull()
    expect(
      getFileExplorerNameFilterEmptyMessageKind({ ...base, hasLoadError: true, truncated: true })
    ).toBeNull()
  })
})

function boundedProvisionalPage(): WorkspacePathSearchResponse {
  return {
    requestIdentity: {
      query: 'item',
      consumer: { consumerId: 'bounded-page', sequence: 1 },
      owner: {
        executionHost: { provider: 'local', incarnationId: 'bounded-page' },
        authorizedCanonicalRoot: '/fixture'
      },
      generationId: 'restored-generation',
      mode: 'name-filter',
      scope: {
        pathSet: 'all',
        includeDotfiles: true,
        includeIgnoredFiles: true,
        excludePathSegments: []
      },
      pageBudget: { maxPaths: 5_000, maxSerializedBytes: 4 * 1024 * 1024 }
    },
    generationId: 'restored-generation',
    scopeFingerprint: 'bounded-page',
    scopeRuleVersion: 'quick-open-scope-v1',
    rows: [],
    rowClassificationFlags: [],
    retainedCount: 0,
    state: {
      coverage: 'partial',
      freshness: 'provisional',
      countProvenance: 'provisional',
      searchComplete: false
    },
    count: { value: null, provenance: 'provisional' },
    degradationReason: 'partial-page-bounded'
  }
}
