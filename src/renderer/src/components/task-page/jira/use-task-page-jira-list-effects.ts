import { translate } from '@/i18n/i18n'
import { isRuntimeProviderSearchQueryWithinLimit } from '@/runtime/issue-search/runtime-provider-search-bounds'
import { withCurrentSprintClause } from '../../../../../shared/jira/jira-jql-predicate'
import {
  buildJiraStatusCatalog,
  jiraListStatusCatalogScopeKey
} from './task-page-jira-status-catalog'
import type { TaskPageLinearCollectionEffectsModel } from '../linear/use-task-page-linear-collection-effects'
import { useEffect, useMemo, useRef } from 'react'
import {
  getSingleJiraProjectScope,
  getTaskPageJiraStatusOrderScopeKey,
  getTaskPageJiraStatusOrderRuntimeScopeKey,
  loadTaskPageJiraProjectStatusOrder
} from '@/components/task-page/jira/task-page-jira-status-order'
import { createTaskPageJiraLoadFailureState } from '@/components/task-page/jira/task-page-jira-load-state'
import { searchTaskPageJiraIssues } from '@/components/task-page/jira/task-page-jira-search'
import { JIRA_ITEM_LIMIT } from '../task-page-source-context'
import { toTaskPageJiraListPage, type TaskPageJiraListPage } from './task-page-jira-list-pagination'
import { useTaskPageJiraListLoadMore } from './use-task-page-jira-list-load-more'
import { useTaskSearchDebouncedApply } from '../use-task-search-debounced-apply'
import { readLinkedJiraIssues } from './task-page-jira-linked-issues'
import { useTaskPageJiraSelectionCleanup } from '../../use-task-page-jira-selection-cleanup'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/rpc/targets/runtime-client-target'
import { buildJiraPresetJql } from '../../../../../shared/jira/jira-preset-jql'
import { restrictJiraQueryToProject } from '../../../../../shared/jira/jira-project-reference'
export function useTaskPageJiraListEffects(model: TaskPageLinearCollectionEffectsModel) {
  const {
    settings,
    jiraBoardViewMode,
    accountBackedTaskSourceHostId,
    jiraHasWorkspace,
    linkedJiraIssueRefs,
    linkedJiraIssueRefsSignature,
    setTaskResumeState,
    searchJiraIssues,
    searchJiraIssuePage,
    listJiraIssuePage,
    jiraConnected,
    selectedJiraSiteId,
    taskSource,
    jiraTaskSourceContext,
    jiraTaskSourceScopeKey,
    jiraSearchPersistReadyRef,
    taskResumeApplied,
    setJiraIssues,
    setJiraListPage,
    setJiraListLoadingMore,
    setJiraListLoadMoreError,
    jiraListGenerationRef,
    setJiraLoading,
    setJiraError,
    setJiraErrorDetailsOpen,
    setJiraJqlRejection,
    jiraSearchInput,
    appliedJiraSearch,
    setAppliedJiraSearch,
    activeJiraPreset,
    jiraCurrentSprint,
    jiraProjectFilter,
    jiraRefreshNonce,
    jiraActiveSavedFilterId,
    jiraSavedFilters,
    jiraSavedFiltersLoading,
    selectedJiraStatuses,
    jiraQuickFiltersLoading,
    jiraFavouriteFilter,
    setJiraStatusCatalog,
    setJiraProjectStatusOrder
  } = model
  const statusOrderOwner = useMemo(
    () =>
      ipcOrRuntimeTargetForHostId(jiraTaskSourceContext?.hostId ?? accountBackedTaskSourceHostId),
    [accountBackedTaskSourceHostId, jiraTaskSourceContext]
  )
  const statusOrderRuntimeScopeKey = getTaskPageJiraStatusOrderRuntimeScopeKey(
    jiraTaskSourceScopeKey,
    statusOrderOwner
  )
  useTaskSearchDebouncedApply(jiraSearchInput, taskResumeApplied, setAppliedJiraSearch)
  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (!jiraSearchPersistReadyRef.current) {
      jiraSearchPersistReadyRef.current = true
      return
    }
    setTaskResumeState({ jiraQuery: appliedJiraSearch.trim() })
  }, [appliedJiraSearch, setTaskResumeState, taskResumeApplied, jiraSearchPersistReadyRef])
  const favourite = jiraHasWorkspace ? null : jiraFavouriteFilter
  const jiraRemoteSearch = jiraHasWorkspace ? '' : (favourite?.jql ?? appliedJiraSearch)
  const statusCatalogScopeKey = jiraListStatusCatalogScopeKey({
    hasWorkspace: jiraHasWorkspace,
    remoteSearch: jiraRemoteSearch,
    selectedStatuses: selectedJiraStatuses,
    sourceScopeKey: jiraTaskSourceScopeKey,
    selectedSiteId: selectedJiraSiteId,
    preset: activeJiraPreset,
    project: jiraProjectFilter
  })
  const previousJiraRefreshNonceRef = useRef(jiraRefreshNonce)
  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (taskSource !== 'jira') {
      return
    }
    if (!jiraConnected || jiraSavedFiltersLoading || jiraQuickFiltersLoading) {
      return
    }
    const force = previousJiraRefreshNonceRef.current !== jiraRefreshNonce
    previousJiraRefreshNonceRef.current = jiraRefreshNonce
    if (settings?.defaultJiraBoard && jiraBoardViewMode === 'board') {
      setJiraIssues([])
      setJiraListPage(null)
      setJiraLoading(false)
      setJiraError(null)
      setJiraErrorDetailsOpen(false)
      return
    }
    let cancelled = false
    let queryTooLong = false
    setJiraLoading(true)
    setJiraError(null)
    setJiraJqlRejection(null)
    setJiraErrorDetailsOpen(false)
    const trimmed = jiraRemoteSearch.trim()
    const savedFilter = jiraSavedFilters.find((filter) => filter.id === jiraActiveSavedFilterId)
    const exactSavedJql = savedFilter?.jql === trimmed
    // Why a captured page rather than a new return shape: the key-or-text and JQL-retry
    // helpers are shared with cmd-J and the composer, and each of them answers with the
    // issues of its last search call, so the last page recorded here is that call's page.
    let page: TaskPageJiraListPage | null = null
    const searchWithinLimit = async (query: string) => {
      if (
        favourite &&
        (!jiraTaskSourceContext ||
          selectedJiraSiteId !== favourite.siteId ||
          (jiraProjectFilter && jiraProjectFilter.siteId !== favourite.siteId))
      ) {
        throw new Error(
          translate(
            'jira.favourites.siteMismatch',
            'Choose a project from the favourite’s Jira site, or clear the project filter.'
          )
        )
      }
      if (!isRuntimeProviderSearchQueryWithinLimit(query)) {
        queryTooLong = true
        throw new Error('Query exceeds the request limit.')
      }
      const result = await searchJiraIssuePage(query, JIRA_ITEM_LIMIT, {
        sourceContext: jiraTaskSourceContext,
        ...(favourite
          ? { siteId: favourite.siteId }
          : jiraProjectFilter
            ? { siteId: jiraProjectFilter.siteId }
            : {}),
        force
      })
      page = toTaskPageJiraListPage(result)
      return result.issues
    }
    const request = jiraHasWorkspace
      ? readLinkedJiraIssues(linkedJiraIssueRefs, searchJiraIssues, jiraTaskSourceContext, force)
      : trimmed.length > 0
        ? searchTaskPageJiraIssues(
            trimmed,
            async (jql) => {
              const sprintJql = jiraCurrentSprint ? withCurrentSprintClause(jql) : jql
              const query = jiraProjectFilter
                ? restrictJiraQueryToProject(sprintJql, jiraProjectFilter)
                : sprintJql
              return searchWithinLimit(query)
            },
            favourite || exactSavedJql ? 'jql' : 'input'
          ).then((result) => ({ ...result, error: null }))
        : jiraProjectFilter
          ? searchWithinLimit(
              restrictJiraQueryToProject(
                buildJiraPresetJql(activeJiraPreset, {
                  statuses: selectedJiraStatuses,
                  currentSprint: jiraCurrentSprint
                }),
                jiraProjectFilter
              )
            ).then((issues) => ({ issues, jqlRejection: null, error: null }))
          : listJiraIssuePage(activeJiraPreset, JIRA_ITEM_LIMIT, {
              sourceContext: jiraTaskSourceContext,
              force,
              ...(selectedJiraStatuses.length || jiraCurrentSprint
                ? {
                    filters: {
                      ...(selectedJiraStatuses.length ? { statuses: selectedJiraStatuses } : {}),
                      ...(jiraCurrentSprint ? { currentSprint: true } : {})
                    }
                  }
                : {})
            }).then((result) => {
              page = toTaskPageJiraListPage(result)
              return { issues: result.issues, jqlRejection: null, error: null }
            })
    void request
      .then((result) => {
        const { issues, jqlRejection } = result
        if (cancelled) {
          return
        }
        setJiraError(result.error)
        if (statusCatalogScopeKey) {
          setJiraStatusCatalog({
            scopeKey: statusCatalogScopeKey,
            items: buildJiraStatusCatalog(issues)
          })
        }
        setJiraIssues(issues)
        setJiraListPage(page)
        setJiraJqlRejection(jqlRejection)
        setJiraLoading(false)
        const projectScope = getSingleJiraProjectScope(issues)
        if (!projectScope || !statusOrderOwner) {
          return
        }
        const statusOrderScopeKey = getTaskPageJiraStatusOrderScopeKey(
          statusOrderRuntimeScopeKey,
          projectScope
        )
        void loadTaskPageJiraProjectStatusOrder(
          statusOrderOwner,
          statusOrderRuntimeScopeKey,
          projectScope
        ).then((order) => {
          if (!cancelled) {
            setJiraProjectStatusOrder({
              order,
              scopeKey: statusOrderScopeKey
            })
          }
        })
      })
      .catch((err) => {
        if (cancelled) {
          return
        }
        const failureState = createTaskPageJiraLoadFailureState(err)
        setJiraIssues(failureState.issues)
        setJiraListPage(null)
        setJiraError(
          queryTooLong
            ? {
                title: translate(
                  'jira.board.queryTooLong',
                  'The Jira query is too long. Shorten the query or clear filters.'
                ),
                details: null
              }
            : failureState.error
        )
        setJiraLoading(false)
      })
    return () => {
      cancelled = true
      // Why: a page that lands after this run must not extend a list it no longer owns.
      jiraListGenerationRef.current += 1
      setJiraListLoadingMore(false)
      setJiraListLoadMoreError(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- linkedJiraIssueRefsSignature stands in for the refs array, which re-derives on unrelated workspace churn; store actions and setters are stable.
  }, [
    taskSource,
    jiraConnected,
    selectedJiraSiteId,
    jiraBoardViewMode,
    settings?.defaultJiraBoard?.boardId,
    settings?.defaultJiraBoard?.siteId,
    jiraRemoteSearch,
    activeJiraPreset,
    jiraHasWorkspace,
    linkedJiraIssueRefsSignature,
    jiraCurrentSprint,
    jiraProjectFilter,
    jiraRefreshNonce,
    jiraActiveSavedFilterId,
    jiraSavedFilters,
    jiraSavedFiltersLoading,
    selectedJiraStatuses,
    jiraQuickFiltersLoading,
    favourite,
    taskResumeApplied,
    jiraTaskSourceContext,
    jiraTaskSourceScopeKey,
    statusOrderOwner,
    statusOrderRuntimeScopeKey
  ])
  // Why shared with load-more: the status options are the loaded issues, so a page that
  // widens the rows must widen them too — and only where this list reads them at all.
  const loadMoreJiraListPage = useTaskPageJiraListLoadMore({ ...model, statusCatalogScopeKey })
  useTaskPageJiraSelectionCleanup(model)

  // Linear string IDs need the provider-generic numeric placeholder 0.
  return Object.assign(model, { loadMoreJiraListPage })
}
export type TaskPageJiraListEffectsModel = ReturnType<typeof useTaskPageJiraListEffects>
