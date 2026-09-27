import { describe, expect, it } from 'vitest'
import type { WorkspacePathSearchFenceIdentity } from '../../../../shared/workspace-path-search-contract'
import {
  createCompleteWorkspacePathSearchResponse,
  createPartialWorkspacePathSearchResponse
} from '../../../../shared/workspace-path-search-response'
import { FileExplorerNameFilterTruncationNotice } from './FileExplorerNameFilterTruncationNotice'

const liveScanIdentity: WorkspacePathSearchFenceIdentity = {
  query: 'item',
  consumer: { consumerId: 'live-scan', sequence: 1 },
  owner: {
    executionHost: { provider: 'local', incarnationId: 'live-scan' },
    authorizedCanonicalRoot: '/fixture'
  },
  generationId: null,
  mode: 'name-filter',
  scope: {
    pathSet: 'all',
    includeDotfiles: true,
    includeIgnoredFiles: true,
    excludePathSegments: []
  },
  pageBudget: { maxPaths: 5_000, maxSerializedBytes: 100_000 }
}

describe('FileExplorerNameFilterTruncationNotice', () => {
  it('says how many matches were found and how many are shown', () => {
    const element = FileExplorerNameFilterTruncationNotice({
      shownCount: 5_000,
      totalCount: 182_311
    })

    expect(element?.props.children).toBe(
      `Showing the first ${(5_000).toLocaleString()} of ${(182_311).toLocaleString()} matches — add more of the name to narrow it down`
    )
  })

  it('labels a retained prior page as updating instead of repeating its old count', () => {
    const element = FileExplorerNameFilterTruncationNotice({
      shownCount: 5,
      totalCount: null,
      isUpdating: true
    })

    expect(element?.props.children).toBe('Updating file list')
  })

  it('never claims a count the host could not provide', () => {
    const element = FileExplorerNameFilterTruncationNotice({
      shownCount: 5_000,
      totalCount: null
    })

    expect(element?.props.children).toBe(
      'Only part of this workspace was searched — add more of the name to narrow it down'
    )
  })

  it('does not label an exact live-scan fallback as still indexing', () => {
    // Regression: the index was still building, but the live scan already finished, so calling
    // these results "Indexing files…" (and hiding that they are complete) was wrong.
    const element = FileExplorerNameFilterTruncationNotice({
      shownCount: 1,
      totalCount: 1,
      isIndexing: true,
      workspacePathSearch: {
        ...createCompleteWorkspacePathSearchResponse({
          requestIdentity: liveScanIdentity,
          paths: ['src/target.ts'],
          totalCount: 1,
          generationId: 'live-1'
        }),
        degradationReason: 'building'
      }
    })

    expect(element?.props.children).toBe(
      'Complete results from a full scan — the file index is still building'
    )
  })

  it('still labels a non-exact building index as indexing', () => {
    const element = FileExplorerNameFilterTruncationNotice({
      shownCount: 0,
      totalCount: null,
      isIndexing: true,
      workspacePathSearch: createPartialWorkspacePathSearchResponse({
        requestIdentity: liveScanIdentity,
        paths: [],
        generationId: 'partial-1',
        degradationReason: 'building'
      })
    })

    expect(element?.props.children).toBe('Indexing files…')
  })
})
