import { ArrowRight, FolderOpen, type LucideIcon } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { JiraIssue } from '../../../shared/jira-types'
import { getJiraIssueWorkspaceActions } from './jira-issue-workspace-actions'

export type JiraIssueRowAction = {
  key: string
  label: string
  icon: LucideIcon
  /** Groups the row's own actions above the detail sheet's links and copies. */
  separatorBefore?: boolean
  onSelect: () => void
}

export type JiraIssueRowWorkspaceAction = Pick<JiraIssueRowAction, 'label' | 'icon' | 'onSelect'>

/** One descriptor list for every surface: the row menu renders it whole, the detail
 *  sheet renders the same copies, and the hover cluster reuses the same labels. */
export function getJiraIssueRowActions(
  issue: JiraIssue,
  workspace: JiraIssueRowWorkspaceAction | null
): JiraIssueRowAction[] {
  const shared = getJiraIssueWorkspaceActions(issue).map((action, index) => ({
    key: action.key,
    label: action.label,
    icon: action.icon,
    separatorBefore: index === 0 && workspace !== null,
    onSelect: action.action
  }))
  return workspace ? [{ key: 'workspace', ...workspace }, ...shared] : shared
}

/** The row's first menu item: the same Show/Start rule the hover cluster follows. */
export function buildJiraIssueRowWorkspaceAction({
  issue,
  linked,
  onOpenOrStartWorkspace,
  onStartWorkspace
}: {
  issue: JiraIssue
  linked: boolean
  onOpenOrStartWorkspace?: (issue: JiraIssue) => void
  onStartWorkspace?: (issue: JiraIssue) => void
}): JiraIssueRowWorkspaceAction | null {
  const openOrStart = onOpenOrStartWorkspace ?? onStartWorkspace
  if (!openOrStart) {
    return null
  }
  return {
    label: linked
      ? translate('auto.components.TaskPage.jiraShowWorkspace', 'Show workspace')
      : translate('auto.components.TaskPage.9497f2787c', 'Start workspace'),
    icon: linked ? FolderOpen : ArrowRight,
    onSelect: () => openOrStart(issue)
  }
}
