import { describe, expect, it } from 'vitest'
import { QUICK_OPEN_LISTING_MAX_RESULTS } from './quick-open-listing-limits'
import { NameFilterPathMatcher } from './quick-open-path-search'
import {
  WORKSPACE_PATH_SEARCH_LOCAL_EXPLORER_MAX_PAGE_PATHS,
  WORKSPACE_PATH_SEARCH_LOCAL_QUERY_MAX_UTF8_BYTES,
  validateWorkspacePathSearchQuery
} from './workspace-path-search-contract'
import {
  generatePathMatchCardinalityCatalog,
  generateWorkspacePathCatalog
} from './__fixtures__/workspace-path-catalog'
import {
  runWorkspacePathSearchQueryBattery,
  WORKSPACE_PATH_SEARCH_QUERY_BATTERY
} from './__fixtures__/workspace-path-search-query-battery'

describe('workspace path-search structural performance contracts', () => {
  it('validates the shared 2 KiB query limit without loosening it', () => {
    expect(validateWorkspacePathSearchQuery('x'.repeat(2_048))).toMatchObject({ ok: true })
    expect(validateWorkspacePathSearchQuery('x'.repeat(2_049))).toMatchObject({
      ok: false,
      reason: 'utf8-byte-limit'
    })
    expect(validateWorkspacePathSearchQuery('é'.repeat(1_024))).toMatchObject({
      ok: true,
      utf8ByteLength: WORKSPACE_PATH_SEARCH_LOCAL_QUERY_MAX_UTF8_BYTES
    })
    expect(validateWorkspacePathSearchQuery('é'.repeat(1_025))).toMatchObject({
      ok: false,
      reason: 'utf8-byte-limit'
    })
  })

  it('keeps name-filter retention bounded and leaves browse listing capacity untouched', () => {
    const matcher = new NameFilterPathMatcher('cardinality match', 5_000)
    for (const path of generatePathMatchCardinalityCatalog(5_100)) {
      matcher.consider(path)
    }
    expect(matcher.result().paths).toHaveLength(5_000)
    expect(matcher.result().totalCount).toBe(5_100)
    expect(WORKSPACE_PATH_SEARCH_LOCAL_EXPLORER_MAX_PAGE_PATHS).toBe(5_000)
    expect(QUICK_OPEN_LISTING_MAX_RESULTS).toBe(20_001)
  })

  it('keeps the oracle battery equivalent on cheap realistic and adversarial profiles', () => {
    for (const profile of ['realistic-shared-prefixes', 'adversarial-long-unshared'] as const) {
      const rows = runWorkspacePathSearchQueryBattery(() =>
        generateWorkspacePathCatalog({ size: 256, profile, seed: 0x50455246 })
      )
      expect(rows).toHaveLength(WORKSPACE_PATH_SEARCH_QUERY_BATTERY.length)
    }
  })
})
