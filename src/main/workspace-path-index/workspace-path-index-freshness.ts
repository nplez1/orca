import type {
  WorkspacePathSearchFreshness,
  WorkspacePathSearchResponse
} from '../../shared/workspace-path-search-contract'

export function withWorkspacePathSearchFreshness(
  response: WorkspacePathSearchResponse,
  freshness: WorkspacePathSearchFreshness
): WorkspacePathSearchResponse {
  if (freshness === 'no-known-gap') {
    return response
  }
  if (response.state.coverage !== 'complete') {
    return {
      ...response,
      state: {
        coverage: response.state.coverage,
        freshness,
        countProvenance: 'provisional',
        searchComplete: false
      },
      count: { value: null, provenance: 'provisional' }
    }
  }
  const countProvenance =
    response.count.provenance === 'exact-snapshot' ? 'last-known' : response.count.provenance
  return {
    ...response,
    state: {
      coverage: 'complete',
      freshness,
      countProvenance,
      searchComplete: true
    },
    count: {
      value: response.count.value,
      provenance: countProvenance
    }
  }
}
