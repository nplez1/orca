import { describe, expect, it } from 'vitest'
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

  it('shows no filter message when the query is empty or the listing failed', () => {
    expect(getFileExplorerNameFilterEmptyMessageKind({ ...base, hasNameFilter: false })).toBeNull()
    expect(getFileExplorerNameFilterEmptyMessageKind({ ...base, hasLoadError: true })).toBeNull()
    expect(
      getFileExplorerNameFilterEmptyMessageKind({ ...base, hasLoadError: true, truncated: true })
    ).toBeNull()
  })
})
