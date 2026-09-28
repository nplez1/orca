import { shouldExcludeQuickOpenRelPath } from './quick-open-filter'
import {
  WORKSPACE_PATH_CATALOG_SCOPE_RULE_VERSION,
  type WorkspacePathCatalogMetadata
} from './workspace-path-catalog'
import { workspacePathCatalogOverlayScopeComplete } from './workspace-path-catalog-overlay'
import type {
  WorkspacePathSearchFenceIdentity,
  WorkspacePathSearchResponse,
  WorkspacePathSearchRowClassificationFlags
} from './workspace-path-search-contract'

/** Assembles the coverage/freshness verdict and retained page into the wire response. */
export function buildWorkspacePathSearchResponse(args: {
  identity: WorkspacePathSearchFenceIdentity
  generationId: string
  metadata: WorkspacePathCatalogMetadata
  prefixes: readonly string[]
  rows: { relativePath: string }[]
  rowClassificationFlags: WorkspacePathSearchRowClassificationFlags[]
  matches: number
  /** False when a bounded provisional page stopped before covering every eligible path. */
  scanComplete?: boolean
}): WorkspacePathSearchResponse {
  const { identity, generationId, metadata, prefixes, rows, rowClassificationFlags, matches } = args
  const scanComplete = args.scanComplete ?? true
  const scopeCovered =
    workspacePathCatalogOverlayScopeComplete(metadata, identity.scope.pathSet) &&
    metadata.coverageExcludePathSegments.every((segments) =>
      shouldExcludeQuickOpenRelPath(segments.join('/'), prefixes)
    )
  const classificationCovered =
    identity.scope.includeIgnoredFiles ||
    (identity.scope.pathSet === 'included'
      ? metadata.includedComplete
      : metadata.classificationComplete)
  const exactSnapshot =
    scanComplete &&
    scopeCovered &&
    classificationCovered &&
    metadata.freshness === 'no-known-gap' &&
    metadata.scopeRuleVersion === WORKSPACE_PATH_CATALOG_SCOPE_RULE_VERSION
  const degradationReason = !scopeCovered
    ? 'uncovered-scope'
    : !classificationCovered
      ? 'classification-pending'
      : exactSnapshot
        ? undefined
        : 'failed'
  const responseBase = {
    requestIdentity: identity,
    generationId,
    // Why: the wire fence and every other producer compare the fingerprint to plain JSON.stringify(scope);
    // the rule version travels in its own `scopeRuleVersion` field.
    scopeFingerprint: JSON.stringify(identity.scope),
    scopeRuleVersion: metadata.scopeRuleVersion,
    rows,
    rowClassificationFlags,
    retainedCount: rows.length
  }
  if (!scanComplete) {
    // A bounded prefix is a real page in natural order, but it covered part of the workspace: it
    // may not claim complete coverage, an exact total, or a definitive empty answer.
    return {
      ...responseBase,
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
  return exactSnapshot
    ? {
        ...responseBase,
        state: {
          coverage: 'complete',
          freshness: 'no-known-gap',
          countProvenance: 'exact-snapshot',
          searchComplete: true
        },
        count: { value: matches, provenance: 'exact-snapshot' }
      }
    : scopeCovered
      ? {
          ...responseBase,
          state: {
            coverage: 'complete',
            freshness: metadata.freshness,
            countProvenance: 'provisional',
            searchComplete: true
          },
          count: { value: null, provenance: 'provisional' },
          degradationReason
        }
      : {
          ...responseBase,
          state: {
            coverage: 'partial',
            freshness: metadata.freshness,
            countProvenance: 'provisional',
            searchComplete: false
          },
          count: { value: null, provenance: 'provisional' },
          degradationReason
        }
}
