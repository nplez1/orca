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

/** One descriptor list for every surface: the row and card menus render it, and the
 *  detail sheet renders the same copies from `getJiraIssueWorkspaceActions`. */
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

/** The Show/Start wording and icon, shared by the row menu, the board cards and the
 *  hover cluster so the conditional lives in one place. */
export function jiraIssueWorkspaceActionLabel(linked: boolean): string {
  return linked
    ? translate('auto.components.TaskPage.jiraShowWorkspace', 'Show workspace')
    : translate('auto.components.TaskPage.9497f2787c', 'Start workspace')
}

/** The row's first menu item. Show is only truthful when a handler can open the
 *  attached workspace: an issue can be linked while only `onStartWorkspace` is wired,
 *  and that handler starts a new one. */
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
  const showAttached = linked && onOpenOrStartWorkspace !== undefined
  return {
    label: jiraIssueWorkspaceActionLabel(showAttached),
    icon: showAttached ? FolderOpen : ArrowRight,
    onSelect: () => openOrStart(issue)
  }
}
