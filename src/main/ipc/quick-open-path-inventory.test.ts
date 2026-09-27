import { describe, expect, it } from 'vitest'
import { QUICK_OPEN_LISTING_MAX_RESULTS } from '../../shared/quick-open-listing-limits'
import {
  clearQuickOpenPathInventories,
  clearQuickOpenPathSearchInstrumentation,
  exportQuickOpenPathSearchInstrumentation,
  recordQuickOpenPathSearchFallback
} from './quick-open-path-inventory'

describe('Quick Open path-index compatibility adapter', () => {
  it('keeps the unscoped browse bound unchanged', () => {
    expect(QUICK_OPEN_LISTING_MAX_RESULTS).toBe(20_001)
  })

  it('clears the service-owned index between isolated callers', () => {
    expect(() => clearQuickOpenPathInventories()).not.toThrow()
    clearQuickOpenPathSearchInstrumentation()
    expect(exportQuickOpenPathSearchInstrumentation()).toEqual([])
  })

  it('records fallback counts without path names or query text', () => {
    recordQuickOpenPathSearchFallback(
      '/workspace/private-project',
      '123e4567-e89b-42d3-a456-426614174031',
      12,
      { paths: ['private-name/secret-target.ts'], totalCount: 1, truncated: false },
      {
        pathsConsidered: 20,
        candidates: 18,
        verifications: 18,
        queryGenerationDurationMs: 1,
        queryPathsDurationMs: 9
      }
    )
    const artifact = JSON.stringify(exportQuickOpenPathSearchInstrumentation())
    expect(artifact).toContain('123e4567-e89b-42d3-a456-426614174031')
    expect(artifact).not.toContain('/workspace/private-project')
    expect(artifact).not.toContain('private-name')
    expect(artifact).not.toContain('secret-target')
  })
})
