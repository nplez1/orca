import { useCallback, useMemo } from 'react'
import type { TaskSourceContext } from '../../../../shared/work-items/task-source-context'
import type { TaskPageJiraListEffectsModel } from './jira/use-task-page-jira-list-effects'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { LinearWorkspaceSelection } from '../../../../shared/linear/workspace-types'
import type { JiraIssue } from '../../../../shared/jira/jira-types'
import { buildLinearIssueLinkedWorkItem } from '@/lib/work-items/linear/linear-linked-work-item'
import { getLinearIssueWorkspaceName } from '../../../../shared/workspace-name'
import { useAppStore } from '@/store'
import { buildJiraIssueWorkspaceAttachmentIndex } from '@/lib/work-items/jira/jira-issue-workspace-attachment'
import { openJiraIssueWorkspaceOrStart } from '@/lib/jira-issue-workspace-open'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspaces/folder-workspace-worktree'
import { openLinearIssueWorkspaceOrStart } from '@/lib/work-items/linear/linear-issue-workspace-open'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { bindTaskPageJiraItemSourceContext } from './jira/task-page-jira-item-source-context'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { shouldHideTaskPageListChrome } from './task-page-list-chrome-visibility'
import { getJiraIssueWorkspaceSeed } from './task-page-source-context'
import { findJiraIssueDefaultRepo } from '../../../../shared/jira/jira-project-reference'
import { getRepoWorkspaceCreationTargetHint } from '@/lib/project-host-workspace-target'
export function useTaskPageComposerActions(model: TaskPageJiraListEffectsModel) {
  const {
    setTaskResumeState,
    allWorktrees,
    folderWorkspaces,
    openModal,
    updateSettings,
    selectLinearWorkspace,
    listLinearTeams,
    checkLinearConnection,
    selectedLinearWorkspaceId,
    jiraSites,
    taskSource,
    linearTaskSourceContext,
    jiraTaskSourceContext,
    gitlabDialogItem,
    dialogWorkItem,
    selectedLinearIssue,
    clearSelectedLinearIssue,
    selectedJiraIssue,
    linearMode,
    setLinearIssues,
    setLinearLoading,
    setLinearError,
    setLinearRefreshNonce,
    setLinearProjectsResult,
    setLinearProjectsError,
    selectedLinearProject,
    setSelectedLinearProject,
    setSelectedLinearProjectDetail,
    setLinearProjectDetailError,
    setLinearProjectTab,
    setLinearProjectIssuesResult,
    setLinearCustomViewsResult,
    setLinearCustomViewsError,
    selectedLinearCustomView,
    setSelectedLinearCustomView,
    setLinearProjectParentView,
    setLinearCustomViewIssuesResult,
    setLinearCustomViewProjectsResult,
    setLinearCustomViewContentsError,
    linearContextResumeAttemptedRef,
    setAvailableTeams,
    setLinearTeamsError,
    setLinearTeamRefreshNonce,
    setLinearTeamSelection
  } = model
  // Linear string IDs need the provider-generic numeric placeholder 0.
  const openComposerForLinearItem = useCallback(
    (issue: LinearIssue): void => {
      const linkedWorkItem = buildLinearIssueLinkedWorkItem(issue)
      openModal('new-workspace-composer', {
        linkedWorkItem,
        taskSourceContext: linearTaskSourceContext,
        prefilledName: getLinearIssueWorkspaceName(issue),
        telemetrySource: 'sidebar'
      })
    },
    [linearTaskSourceContext, openModal]
  )
  const handleUseLinearItem = useCallback(
    (issue: LinearIssue): void => {
      // Open the prefilled dialog so name, agent and setup still receive user confirmation.
      useAppStore.getState().recordFeatureInteraction('linear-tasks')
      openComposerForLinearItem(issue)
    },
    [openComposerForLinearItem]
  )
  const handleOpenOrUseLinearItem = useCallback(
    (issue: LinearIssue): void => {
      if (openLinearIssueWorkspaceOrStart(issue, () => handleUseLinearItem(issue)) === 'opened') {
        useAppStore.getState().recordFeatureInteraction('linear-tasks')
      }
    },
    [handleUseLinearItem]
  )
  const handleLinearWorkspaceChange = useCallback(
    (workspaceId: LinearWorkspaceSelection): void => {
      clearSelectedLinearIssue()
      setSelectedLinearProject(null)
      setSelectedLinearProjectDetail(null)
      setSelectedLinearCustomView(null)
      setLinearProjectParentView(null)
      setLinearProjectTab('overview')
      setLinearProjectsResult({
        items: []
      })
      setLinearCustomViewsResult({
        items: []
      })
      setLinearProjectIssuesResult({
        items: []
      })
      setLinearCustomViewIssuesResult({
        items: []
      })
      setLinearCustomViewProjectsResult({
        items: []
      })
      setLinearProjectDetailError(null)
      setLinearProjectsError(null)
      setLinearCustomViewsError(null)
      setLinearCustomViewContentsError(null)
      setTaskResumeState({
        linearMode,
        linearContext: undefined
      })
      linearContextResumeAttemptedRef.current = false
      setLinearIssues([])
      setLinearError(null)
      setLinearLoading(true)
      void selectLinearWorkspace(workspaceId)
        .then(() => {
          setLinearTeamRefreshNonce((n) => n + 1)
        })
        .catch(() => {
          setLinearLoading(false)
          toast.error(
            translate('auto.components.TaskPage.d0d570b306', 'Failed to switch Linear workspace.')
          )
        })
    },
    [
      clearSelectedLinearIssue,
      linearMode,
      selectLinearWorkspace,
      setTaskResumeState,
      linearContextResumeAttemptedRef,
      setSelectedLinearProjectDetail,
      setLinearProjectTab,
      setLinearProjectsError,
      setLinearProjectsResult,
      setLinearCustomViewIssuesResult,
      setLinearCustomViewsError,
      setSelectedLinearProject,
      setSelectedLinearCustomView,
      setLinearTeamRefreshNonce,
      setLinearProjectParentView,
      setLinearProjectIssuesResult,
      setLinearCustomViewsResult,
      setLinearCustomViewProjectsResult,
      setLinearError,
      setLinearLoading,
      setLinearProjectDetailError,
      setLinearCustomViewContentsError,
      setLinearIssues
    ]
  )
  const handleLinearTeamSelectionChange = useCallback(
    (next: ReadonlySet<string>, persisted: string[] | null): void => {
      setLinearTeamSelection(new Set(next))
      void updateSettings({
        defaultLinearTeamSelection: persisted
      }).catch(() => {
        toast.error(
          translate('auto.components.TaskPage.3f594861a5', 'Failed to save team selection.')
        )
      })
    },
    [updateSettings, setLinearTeamSelection]
  )
  const handleLinearScopeOpen = useCallback((): void => {
    void checkLinearConnection(true)
    void listLinearTeams(selectedLinearWorkspaceId, {
      force: true,
      // Why: without it the store resolves a failed read as an empty list, so the catch never runs.
      rejectReadError: true
    })
      .then((teams) => {
        setAvailableTeams(teams)
        setLinearTeamsError(false)
      })
      .catch(() => {
        setLinearTeamsError(true)
        console.warn('[TaskPage] Failed to refresh Linear teams')
      })
  }, [
    checkLinearConnection,
    listLinearTeams,
    selectedLinearWorkspaceId,
    setAvailableTeams,
    setLinearTeamsError
  ])
  const handleLinearAccessConnected = useCallback((): void => {
    setLinearTeamRefreshNonce((n) => n + 1)
    setLinearRefreshNonce((n) => n + 1)
  }, [setLinearTeamRefreshNonce, setLinearRefreshNonce])
  const openComposerForJiraItem = useCallback(
    (issue: JiraIssue): void => {
      const taskSourceContext = bindTaskPageJiraItemSourceContext({
        issue,
        sites: jiraSites,
        sourceContext: jiraTaskSourceContext
      })
      if (!taskSourceContext) {
        // Why: composer drops Jira items without matching source context — refuse rather than create unlinked.
        toast.error(
          translate(
            'auto.components.TaskPage.jiraLinkSourceUnavailable',
            'Couldn’t link this Jira issue. Reconnect Jira or pick the matching site, then try again.'
          )
        )
        return
      }
      const linkedWorkItem: LinkedWorkItemSummary = {
        type: 'issue',
        provider: 'jira',
        number: 0,
        title: `${issue.key} ${issue.title}`,
        url: issue.url,
        jiraIdentifier: issue.key
      }
      const mappedRepo = findJiraIssueDefaultRepo(model.repos, issue, taskSourceContext.hostId)
      openModal('new-workspace-composer', {
        linkedWorkItem,
        taskSourceContext,
        initialRepoId: mappedRepo?.id,
        initialWorkspaceTarget: mappedRepo
          ? getRepoWorkspaceCreationTargetHint(mappedRepo, useAppStore.getState().projectHostSetups)
          : undefined,
        prefilledName: getJiraIssueWorkspaceSeed(issue),
        telemetrySource: 'sidebar'
      })
    },
    [jiraSites, jiraTaskSourceContext, model.repos, openModal]
  )
  const handleUseJiraItem = useCallback(
    (issue: JiraIssue): void => {
      useAppStore.getState().recordFeatureInteraction('jira-tasks')
      openComposerForJiraItem(issue)
    },
    [openComposerForJiraItem]
  )
  const handleOpenOrUseJiraItem = useCallback(
    (
      issue: JiraIssue,
      source: TaskSourceContext | null | undefined = jiraTaskSourceContext
    ): void => {
      if (
        openJiraIssueWorkspaceOrStart(issue, source, () => handleUseJiraItem(issue)) === 'opened'
      ) {
        useAppStore.getState().recordFeatureInteraction('jira-tasks')
      }
    },
    [handleUseJiraItem, jiraTaskSourceContext]
  )
  // Why: one pass over workspaces per list render; per-row scans re-read every attachment list.
  const jiraIssueAttachmentIndex = useMemo(
    () =>
      buildJiraIssueWorkspaceAttachmentIndex([
        ...allWorktrees,
        ...folderWorkspaces.map(folderWorkspaceToWorktree)
      ]),
    [allWorktrees, folderWorkspaces]
  )
  const taskPageListChromeHidden = shouldHideTaskPageListChrome({
    taskSource,
    hasGitHubDetail: Boolean(dialogWorkItem),
    hasGitLabDetail: Boolean(gitlabDialogItem),
    hasJiraDetail: Boolean(selectedJiraIssue),
    hasLinearIssueDetail: Boolean(selectedLinearIssue),
    hasLinearProjectContext: Boolean(selectedLinearProject),
    hasLinearViewContext: Boolean(selectedLinearCustomView)
  })
  return {
    ...model,
    openComposerForLinearItem,
    handleUseLinearItem,
    handleOpenOrUseLinearItem,
    handleLinearWorkspaceChange,
    handleLinearTeamSelectionChange,
    handleLinearScopeOpen,
    handleLinearAccessConnected,
    openComposerForJiraItem,
    handleUseJiraItem,
    handleOpenOrUseJiraItem,
    jiraIssueAttachmentIndex,
    taskPageListChromeHidden
  }
}
export type TaskPageComposerActionsModel = ReturnType<typeof useTaskPageComposerActions>
