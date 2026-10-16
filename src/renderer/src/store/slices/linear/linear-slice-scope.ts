import type { AppState } from '../../types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import {
  getTaskSourceCacheScope,
  getTaskSourceRuntimeSettings
} from '../../../../../shared/task-source-context'
import {
  canonicalizeLinearIssueAttributeFilter,
  isEmptyLinearIssueAttributeFilter,
  type LinearIssueAttributeFilter
} from '../../../../../shared/linear/issue-attribute-filter'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { getLinearCacheGeneration, getLinearMutationGeneration } from './linear-slice-request-state'
import { defaultScopeHost } from '@/lib/default-creation-host'
import type { OwnedSource } from '@/lib/provider-source-target'

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
  cachePrefix: string | null
  explicitSource: boolean
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
  if (!sourceContext) {
    return {
      // Why: no Tasks source chosen yet; the default scope host is the row-less source's host.
      settings: defaultScopeHost(settings),
      contextKey: getProviderRuntimeContextKey(settings),
      cachePrefix: null,
      explicitSource: false
    }
  }
  const runtimeSettings = getTaskSourceRuntimeSettings(sourceContext)
  const cachePrefix = getTaskSourceCacheScope(sourceContext)
  return {
    settings: sourceContext,
    contextKey: `${getProviderRuntimeContextKey(runtimeSettings)}::${cachePrefix}`,
    cachePrefix,
    explicitSource: true
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
