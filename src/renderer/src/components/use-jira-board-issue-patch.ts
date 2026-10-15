import { useCallback } from 'react'
import type { MutableRefObject } from 'react'
import type { JiraIssue } from '../../../shared/jira-types'
import type { TaskPageJiraBoardCachedPage } from './task-page-jira-board-cache'

/**
 * Applies a local-only patch to one issue in both loaded board scopes, so an
 * optimistic move renders before Jira confirms it. Deliberately not cached: a
 * status Jira has not accepted must not become the value a reload trusts.
 */
export function useJiraBoardIssuePatch({
  sprintPageRef,
  backlogPageRef,
  setSprintPageLocal,
  setBacklogPageLocal
}: {
  sprintPageRef: MutableRefObject<TaskPageJiraBoardCachedPage>
  backlogPageRef: MutableRefObject<TaskPageJiraBoardCachedPage>
  setSprintPageLocal: (page: TaskPageJiraBoardCachedPage) => void
  setBacklogPageLocal: (page: TaskPageJiraBoardCachedPage) => void
}): (key: string, patch: Partial<JiraIssue>, siteId?: string | null) => void {
  return useCallback(
    (key: string, patch: Partial<JiraIssue>, siteId?: string | null) => {
      const apply = (page: TaskPageJiraBoardCachedPage): TaskPageJiraBoardCachedPage => {
        let changed = false
        const issues = page.issues.map((issue) => {
          if (issue.key !== key || (siteId && issue.siteId !== siteId)) {
            return issue
          }
          changed = true
          return { ...issue, ...patch }
        })
        return changed ? { ...page, issues } : page
      }
      setSprintPageLocal(apply(sprintPageRef.current))
      setBacklogPageLocal(apply(backlogPageRef.current))
    },
    [backlogPageRef, setBacklogPageLocal, setSprintPageLocal, sprintPageRef]
  )
}
