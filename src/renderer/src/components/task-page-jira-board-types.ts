import type { TaskPageComposerActionsModel } from './use-task-page-composer-actions'

export type TaskPageJiraBoardModel = Pick<
  TaskPageComposerActionsModel,
  | 'settings'
  | 'jiraTaskSourceContext'
  | 'jiraStatus'
  | 'jiraIssueAttachmentIndex'
  | 'selectedJiraIssue'
  | 'openJiraDetailPage'
  | 'handleOpenOrUseJiraItem'
>
