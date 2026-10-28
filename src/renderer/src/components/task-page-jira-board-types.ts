import type { TaskPageComposerActionsModel } from './task-page/use-task-page-composer-actions'

export type TaskPageJiraBoardModel = Pick<
  TaskPageComposerActionsModel,
  | 'accountBackedTaskSourceHostId'
  | 'jiraTaskSourceContext'
  | 'jiraStatus'
  | 'jiraIssueAttachmentIndex'
  | 'selectedJiraIssue'
  | 'openJiraDetailPage'
  | 'handleOpenOrUseJiraItem'
  | 'handleUseJiraItem'
  | 'getJiraIssueWorkspaces'
>
