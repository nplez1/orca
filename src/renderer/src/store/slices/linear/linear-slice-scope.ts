import type { AppState } from '../../types'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import { getTaskSourceCacheScope } from '../../../../../shared/work-items/task-source-context'
import {
  canonicalizeLinearIssueAttributeFilter,
  isEmptyLinearIssueAttributeFilter,
  type LinearIssueAttributeFilter
} from '../../../../../shared/linear/issue-attribute-filter'
import {
  getProviderRuntimeContextKey,
  getEnvironmentRuntimeContextKey
} from '@/runtime/hosts/observations/provider-runtime-context'
import { getLinearCacheGeneration, getLinearMutationGeneration } from './linear-slice-request-state'
import { defaultScopeHost } from '@/runtime/hosts/selection/default-creation-host'
import { ownedSourceTarget, type OwnedSource } from '@/lib/provider-source-target'

export function normalizeListAttributeFilter(
  attributeFilter?: LinearIssueAttributeFilter | null
): LinearIssueAttributeFilter | undefined {
  if (!attributeFilter || isEmptyLinearIssueAttributeFilter(attributeFilter)) {
    return undefined
  }
  return canonicalizeLinearIssueAttributeFilter(attributeFilter)
}

export type LinearReadScope = {
  settings: OwnedSource
  contextKey: string
  runtimeContextKey: string
  cachePrefix: string | null
  explicitSource: boolean
  isCurrentRuntime: () => boolean
}

export function isCurrentLinearRuntimeContext(
  contextKey: string,
  settings: AppState['settings']
): boolean {
  return getProviderRuntimeContextKey(settings) === contextKey
}

export function canWriteLinearReadResult(
  contextKey: string,
  generation: number,
  mutationGeneration: number,
  settings: AppState['settings'],
  explicitSource = false
): boolean {
  return (
    generation === getLinearCacheGeneration() &&
    mutationGeneration === getLinearMutationGeneration() &&
    (explicitSource || isCurrentLinearRuntimeContext(contextKey, settings))
  )
}

export function getLinearReadScope(
  settings: AppState['settings'],
  sourceContext?: TaskSourceContext | null
): LinearReadScope {
  return getLinearSourceScope(sourceContext ?? defaultScopeHost(settings), Boolean(sourceContext))
}

/**
 * Scope for an owned source. An `OwnedSource` always names its owner, so it is explicit; only the
 * row-less default scope a page picks up before a source is chosen follows the focused runtime.
 */
export function getLinearSourceScope(source: OwnedSource, explicit = true): LinearReadScope {
  const target = ownedSourceTarget(source)
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const runtimeKey = getEnvironmentRuntimeContextKey(environmentId)
  const cachePrefix = source.kind === 'task-source' ? getTaskSourceCacheScope(source) : null
  return {
    settings: source,
    runtimeContextKey: runtimeKey,
    contextKey: cachePrefix ? `${runtimeKey}::${cachePrefix}` : runtimeKey,
    cachePrefix,
    explicitSource: explicit,
    isCurrentRuntime: () => getEnvironmentRuntimeContextKey(environmentId) === runtimeKey
  }
}

export function scopedLinearCacheKey(
  scope: Pick<LinearReadScope, 'cachePrefix'>,
  key: string
): string {
  return scope.cachePrefix ? `${scope.cachePrefix}::${key}` : key
}

/** Cache key for a read scoped to an explicit source, where no row-less fallback applies. */
export function scopedLinearCacheKeyForSource(source: TaskSourceContext, key: string): string {
  return scopedLinearCacheKey({ cachePrefix: getTaskSourceCacheScope(source) }, key)
}

export function canPublishLinearScopeCache(
  scope: LinearReadScope,
  settings: AppState['settings']
): boolean {
  return (
    scope.isCurrentRuntime() &&
    (scope.cachePrefix !== null ||
      scope.runtimeContextKey === getProviderRuntimeContextKey(settings))
  )
}
