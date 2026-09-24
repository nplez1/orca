import type { Dispatch, SetStateAction } from 'react'
import type { JiraBoardIssuePage, JiraIssue } from '../../../shared/jira-types'

function nextStartAt(page: JiraBoardIssuePage): number {
  return page.startAt + page.issues.length
}

export function applySprintIssuePage(
  page: JiraBoardIssuePage,
  setIssues: Dispatch<SetStateAction<JiraIssue[]>>,
  setStartAt: Dispatch<SetStateAction<number>>,
  setPageToken: Dispatch<SetStateAction<string | null>>,
  setIsLast: Dispatch<SetStateAction<boolean>>,
  append = false
): void {
  setIssues((current) => (append ? [...current, ...page.issues] : page.issues))
  setStartAt(nextStartAt(page))
  setPageToken(page.nextPageToken)
  setIsLast(page.isLast)
}

export function applyBacklogIssuePage(
  page: JiraBoardIssuePage,
  append: boolean,
  setIssues: Dispatch<SetStateAction<JiraIssue[]>>,
  setStartAt: Dispatch<SetStateAction<number>>,
  setPageToken: Dispatch<SetStateAction<string | null>>,
  setTotal: Dispatch<SetStateAction<number | null>>,
  setIsLast: Dispatch<SetStateAction<boolean>>
): void {
  setIssues((current) => (append ? [...current, ...page.issues] : page.issues))
  setStartAt(nextStartAt(page))
  setPageToken(page.nextPageToken)
  setTotal(page.total)
  setIsLast(page.isLast)
}
