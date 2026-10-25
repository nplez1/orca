import { useEffect } from 'react'
import type { TaskPageLinearCollectionEffectsModel } from './task-page/linear/use-task-page-linear-collection-effects'

export type TaskPageJiraSelectionCleanupModel = Pick<
  TaskPageLinearCollectionEffectsModel,
  | 'taskResumeApplied'
  | 'taskSource'
  | 'jiraConnected'
  | 'displayedJiraIssues'
  | 'selectedJiraIssueKey'
  | 'setSelectedJiraIssueKey'
  | 'selectedJiraIssueFallback'
  | 'setSelectedJiraIssueFallback'
>

export function useTaskPageJiraSelectionCleanup(model: TaskPageJiraSelectionCleanupModel): void {
  const {
    taskResumeApplied,
    taskSource,
    jiraConnected,
    displayedJiraIssues,
    selectedJiraIssueKey,
    setSelectedJiraIssueKey,
    selectedJiraIssueFallback,
    setSelectedJiraIssueFallback
  } = model
  useEffect(() => {
    if (!taskResumeApplied || taskSource !== 'jira') {
      return
    }
    if (!jiraConnected || displayedJiraIssues.length === 0) {
      if (selectedJiraIssueKey !== null) {
        setSelectedJiraIssueKey(null)
      }
      if (selectedJiraIssueFallback !== null) {
        setSelectedJiraIssueFallback(null)
      }
      return
    }
    if (
      selectedJiraIssueKey &&
      !displayedJiraIssues.some((issue) => issue.key === selectedJiraIssueKey)
    ) {
      setSelectedJiraIssueKey(null)
      setSelectedJiraIssueFallback(null)
    }
  }, [
    displayedJiraIssues,
    jiraConnected,
    selectedJiraIssueFallback,
    selectedJiraIssueKey,
    taskResumeApplied,
    taskSource,
    setSelectedJiraIssueFallback,
    setSelectedJiraIssueKey
  ])
}
