import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import type { JiraIssue } from '../../../../../shared/jira/jira-types'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import type { JiraSlice } from '@/store/slices/jira/jira-slice-contract'
import type { JiraProjectReference } from '../../../../../shared/jira/jira-project-reference'
import type { JiraStatusCatalogItem } from './task-page-jira-status-catalog'
import { JIRA_ITEM_LIMIT } from '../task-page-source-context'
import {
  appendJiraIssuePage,
  toTaskPageJiraListPage,
  type TaskPageJiraListPage
} from './task-page-jira-list-pagination'
import { buildJiraStatusCatalog } from './task-page-jira-status-catalog'

/** Only what the read touches: naming the whole effects model here would make the
 *  effect that calls this hook and this hook's argument type depend on each other. */
export type TaskPageJiraListLoadMoreArgs = {
  jiraIssues: JiraIssue[]
  setJiraIssues: Dispatch<SetStateAction<JiraIssue[]>>
  jiraListPage: TaskPageJiraListPage | null
  setJiraListPage: Dispatch<SetStateAction<TaskPageJiraListPage | null>>
  jiraListGenerationRef: MutableRefObject<number>
  jiraListLoadingMore: boolean
  setJiraListLoadingMore: Dispatch<SetStateAction<boolean>>
  setJiraListLoadMoreError: Dispatch<SetStateAction<string | null>>
  jiraLoading: boolean
  jiraTaskSourceContext: TaskSourceContext | null | undefined
  loadMoreJiraIssues: JiraSlice['loadMoreJiraIssues']
  /** Whether this list is the one whose status options come from the loaded issues, and the
   *  scope those options belong to; load-more widens both the rows and the options. */
  statusCatalogScopeKey: string | null
  setJiraStatusCatalog: (value: { scopeKey: string; items: JiraStatusCatalogItem[] }) => void
  jiraProjectFilter?: JiraProjectReference | null
}

/** Extends the rendered list by one page. Lives outside the fetch effect because the
 *  continuation belongs to a page the effect has already committed. */
export function useTaskPageJiraListLoadMore(model: TaskPageJiraListLoadMoreArgs) {
  const {
    jiraIssues,
    setJiraIssues,
    jiraListPage,
    setJiraListPage,
    jiraListGenerationRef,
    jiraListLoadingMore,
    setJiraListLoadingMore,
    setJiraListLoadMoreError,
    jiraLoading,
    jiraTaskSourceContext,
    loadMoreJiraIssues,
    statusCatalogScopeKey,
    setJiraStatusCatalog
  } = model

  const loadMoreJiraListPage = useCallback(async (): Promise<void> => {
    const continuation = jiraListPage?.continuation
    // Why the loading guards: a read in flight owns the page, so a page appended over it
    // would write a pre-reload snapshot back over the reload's own answer.
    if (!continuation || jiraListLoadingMore || jiraLoading) {
      return
    }
    const generation = jiraListGenerationRef.current
    setJiraListLoadingMore(true)
    setJiraListLoadMoreError(null)
    try {
      const next = await loadMoreJiraIssues(continuation, JIRA_ITEM_LIMIT, {
        sourceContext: jiraTaskSourceContext
      })
      if (generation !== jiraListGenerationRef.current) {
        return
      }
      const issues = appendJiraIssuePage(jiraIssues, next.issues)
      setJiraIssues(issues)
      setJiraListPage(toTaskPageJiraListPage(next))
      if (statusCatalogScopeKey) {
        setJiraStatusCatalog({
          scopeKey: statusCatalogScopeKey,
          items: buildJiraStatusCatalog(issues)
        })
      }
    } catch (error) {
      if (generation !== jiraListGenerationRef.current) {
        return
      }
      setJiraListLoadMoreError(
        extractIpcErrorMessage(
          error,
          translate(
            'auto.components.TaskPage.jiraListLoadMoreFailed',
            'Unable to load more Jira issues.'
          )
        )
      )
    } finally {
      // Why the guard: a stale read must not clear a flag the current one now owns.
      if (generation === jiraListGenerationRef.current) {
        setJiraListLoadingMore(false)
      }
    }
  }, [
    jiraIssues,
    jiraListGenerationRef,
    jiraListLoadingMore,
    jiraListPage,
    jiraLoading,
    jiraTaskSourceContext,
    loadMoreJiraIssues,
    setJiraIssues,
    setJiraListLoadMoreError,
    setJiraListLoadingMore,
    setJiraListPage,
    setJiraStatusCatalog,
    statusCatalogScopeKey
  ])

  return loadMoreJiraListPage
}
