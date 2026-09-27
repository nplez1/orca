import {
  WORKSPACE_PATH_CATALOG_FOLD_VERSION,
  WORKSPACE_PATH_CATALOG_SCOPE_RULE_VERSION,
  type WorkspacePathCatalogMetadata
} from '../../shared/workspace-path-catalog'
import type { WorkspacePathSearchPathSet } from '../../shared/workspace-path-search-contract'

export function firstScopeMetadata(
  pathSet: WorkspacePathSearchPathSet,
  foldLocale: string
): WorkspacePathCatalogMetadata {
  return {
    foldLocale,
    foldVersion: WORKSPACE_PATH_CATALOG_FOLD_VERSION,
    scopeRuleVersion: WORKSPACE_PATH_CATALOG_SCOPE_RULE_VERSION,
    includedComplete: pathSet === 'included',
    allComplete: pathSet === 'all',
    classificationComplete: false,
    coverageExcludePathSegments: [],
    freshness: 'no-known-gap'
  }
}

export function completeScopeMetadata(foldLocale: string): WorkspacePathCatalogMetadata {
  return {
    foldLocale,
    foldVersion: WORKSPACE_PATH_CATALOG_FOLD_VERSION,
    scopeRuleVersion: WORKSPACE_PATH_CATALOG_SCOPE_RULE_VERSION,
    includedComplete: true,
    allComplete: true,
    classificationComplete: true,
    coverageExcludePathSegments: [],
    freshness: 'no-known-gap'
  }
}
