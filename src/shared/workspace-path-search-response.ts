import type {
  WorkspacePathSearchFenceIdentity,
  WorkspacePathSearchResponse,
  WorkspacePathSearchRowClassificationFlags
} from './workspace-path-search-contract'

export function createCompleteWorkspacePathSearchResponse(args: {
  requestIdentity: WorkspacePathSearchFenceIdentity
  paths: readonly string[]
  totalCount: number
  generationId: string
}): WorkspacePathSearchResponse {
  const scopeFingerprint = JSON.stringify(args.requestIdentity.scope)
  const rowClassificationFlags = args.paths.map(classifyDotfilePath)
  return {
    requestIdentity: args.requestIdentity,
    generationId: args.generationId,
    scopeFingerprint,
    scopeRuleVersion: 'live-path-search-v1',
    rows: args.paths.map((relativePath) => ({ relativePath })),
    rowClassificationFlags,
    retainedCount: args.paths.length,
    state: {
      coverage: 'complete',
      freshness: 'no-known-gap',
      countProvenance: 'exact-snapshot',
      searchComplete: true
    },
    count: { value: args.totalCount, provenance: 'exact-snapshot' }
  }
}

export function createPartialWorkspacePathSearchResponse(args: {
  requestIdentity: WorkspacePathSearchFenceIdentity
  paths: readonly string[]
  generationId: string
  degradationReason: string
}): WorkspacePathSearchResponse {
  const scopeFingerprint = JSON.stringify(args.requestIdentity.scope)
  return {
    requestIdentity: args.requestIdentity,
    generationId: args.generationId,
    scopeFingerprint,
    scopeRuleVersion: 'legacy-bounded-list-v1',
    rows: args.paths.map((relativePath) => ({ relativePath })),
    rowClassificationFlags: args.paths.map(classifyDotfilePath),
    retainedCount: args.paths.length,
    state: {
      coverage: 'partial',
      freshness: 'unknown',
      countProvenance: 'legacy',
      searchComplete: false
    },
    count: { value: null, provenance: 'legacy' },
    degradationReason: args.degradationReason
  }
}

function classifyDotfilePath(path: string): WorkspacePathSearchRowClassificationFlags {
  let start = 0
  while (start < path.length) {
    const end = path.indexOf('/', start)
    const stop = end === -1 ? path.length : end
    if (path.charCodeAt(start) === 46) {
      return 2
    }
    start = stop + 1
  }
  return 0
}
