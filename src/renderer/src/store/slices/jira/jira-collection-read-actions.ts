import { jiraListIssuesForTarget, jiraSearchIssues } from '@/runtime/jira/runtime-jira-client'
import { getJiraRuntimeTarget } from '@/runtime/jira/runtime-jira-target'
import { isIntegrationCredentialDecryptionError } from '../../../../../shared/integration-credential-errors'
import type { JiraSiteSelection } from '../../../../../shared/jira/jira-types'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import type { JiraSlice, JiraSliceGet, JiraSliceSet } from './jira-slice-contract'
import {
  cachedIssues,
  collectionKey,
  issuesEntry,
  listFilters,
  readCollection,
  type JiraCollectionReadGateFactory
} from './jira-collection-read-core'
import { createJiraCollectionPageReadActions } from './jira-collection-page-read-actions'
import {
  canWriteJiraReadResult,
  currentJiraMutationGeneration,
  getJiraReadScope,
  getSelectedJiraSiteId,
  inflightListRequests,
  inflightSearchRequests,
  looksLikeJiraAuthError,
  markJiraConnectionLost,
  shouldRefreshJiraStatusAfterRead,
  type JiraReadScope
} from './jira-read-coordination'

type JiraCollectionReadActions = Pick<
  JiraSlice,
  | 'searchJiraIssues'
  | 'listJiraIssues'
  | 'searchJiraIssuePage'
  | 'listJiraIssuePage'
  | 'loadMoreJiraIssues'
>

/** One hop each, so this file's routing stays in one place however many reads it grows. */
function scopeFor(
  get: JiraSliceGet,
  sourceContext: TaskSourceContext | null | undefined
): JiraReadScope {
  return getJiraReadScope(get().settings, sourceContext)
}

function canWrite(scope: JiraReadScope, mutationGeneration: number, get: JiraSliceGet): boolean {
  return canWriteJiraReadResult(
    scope.contextKey,
    mutationGeneration,
    get().settings,
    scope.explicitSource
  )
}

function recordReadFailure(
  error: unknown,
  scope: JiraReadScope,
  siteId: JiraSiteSelection | null | undefined,
  mutationGeneration: number,
  set: JiraSliceSet,
  get: JiraSliceGet,
  options: { abortable?: boolean; currentRequest: boolean }
): void {
  const writable = options.currentRequest && canWrite(scope, mutationGeneration, get)
  if (isIntegrationCredentialDecryptionError(error) && writable) {
    if (!shouldRefreshJiraStatusAfterRead(siteId, get().jiraStatus, options)) {
      void get().checkJiraConnection()
    }
  } else if (looksLikeJiraAuthError(error) && writable) {
    markJiraConnectionLost(set, scope)
  }
  if (isIntegrationCredentialDecryptionError(error) || looksLikeJiraAuthError(error)) {
    return
  }
  throw error
}

export function createJiraCollectionReadActions(
  set: JiraSliceSet,
  get: JiraSliceGet
): JiraCollectionReadActions {
  const gateFor: JiraCollectionReadGateFactory = (sourceContext) => {
    const scope = scopeFor(get, sourceContext)
    const mutationGeneration = currentJiraMutationGeneration()
    return {
      scope,
      canWrite: () => canWrite(scope, mutationGeneration, get),
      recordFailure: (error, siteId, options) =>
        recordReadFailure(error, scope, siteId, mutationGeneration, set, get, options)
    }
  }

  return {
    ...createJiraCollectionPageReadActions(set, get, gateFor),

    searchJiraIssues: async (jql, limit = 30, options = {}) => {
      const gate = gateFor(options.sourceContext)
      const siteId = 'siteId' in options ? options.siteId : getSelectedJiraSiteId(get().jiraStatus)
      return readCollection(
        {
          cacheKey: collectionKey(gate.scope, jql, siteId, limit, undefined),
          inflight: inflightSearchRequests,
          gate,
          siteId,
          options,
          read: () => jiraSearchIssues(gate.scope.settings, jql, limit, siteId, options.signal),
          empty: [],
          fromCache: cachedIssues,
          toCacheEntry: issuesEntry
        },
        set,
        get
      )
    },

    listJiraIssues: async (filter = 'assigned', limit = 30, options = {}) => {
      const gate = gateFor(options.sourceContext)
      const siteId = getSelectedJiraSiteId(get().jiraStatus)
      const filters = listFilters(options.filters)
      return readCollection(
        {
          cacheKey: collectionKey(gate.scope, `list::${filter}`, siteId, limit, filters),
          inflight: inflightListRequests,
          gate,
          siteId,
          options,
          read: () =>
            jiraListIssuesForTarget(
              getJiraRuntimeTarget(gate.scope.settings),
              filter,
              limit,
              siteId,
              filters
            ),
          empty: [],
          fromCache: cachedIssues,
          toCacheEntry: issuesEntry
        },
        set,
        get
      )
    }
  }
}
