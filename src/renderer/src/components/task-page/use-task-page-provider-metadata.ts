import type { TaskPageResumeRestorationModel } from './use-task-page-resume-restoration'
import { useState, useEffect, useRef, useCallback } from 'react'
import type { LinearTeam } from '../../../../shared/linear/workspace-types'
import type { JiraProject } from '../../../../shared/jira/jira-types'
import { defaultScopeHost } from '@/runtime/hosts/selection/default-creation-host'
import { jiraListProjects } from '@/runtime/jira/runtime-jira-client'

const EMPTY_JIRA_PROJECTS: JiraProject[] = []
const EMPTY_LINEAR_TEAMS: LinearTeam[] = []

type JiraProjectsSnapshot = {
  scopeKey: string
  projects: JiraProject[]
  failed: boolean
}

export function useTaskPageProviderMetadata(model: TaskPageResumeRestorationModel) {
  const {
    settings,
    getCachedLinearTeams,
    listLinearTeams,
    linearConnected,
    jiraConnected,
    selectedLinearWorkspaceId,
    selectedJiraSiteId,
    taskSource,
    linearTaskSourceContext,
    jiraTaskSourceContext,
    jiraTaskSourceScopeKey,
    taskResumeApplied
  } = model
  // Fetch all teams; the current issue window may contain only a subset.
  const [availableTeams, setAvailableTeams] = useState<LinearTeam[]>([])
  const [linearTeamsError, setLinearTeamsError] = useState(false)
  const [linearTeamRefreshNonce, setLinearTeamRefreshNonce] = useState(0)
  const previousLinearTeamRefreshNonceRef = useRef(linearTeamRefreshNonce)
  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (taskSource !== 'linear' || !linearConnected) {
      setAvailableTeams(EMPTY_LINEAR_TEAMS)
      setLinearTeamsError(false)
      return
    }
    // Why: only an explicit refresh bypasses the team cache; a scope change may reuse it.
    const force = previousLinearTeamRefreshNonceRef.current !== linearTeamRefreshNonce
    previousLinearTeamRefreshNonceRef.current = linearTeamRefreshNonce
    let cancelled = false
    const cachedTeams = getCachedLinearTeams(selectedLinearWorkspaceId, {
      sourceContext: linearTaskSourceContext
    })
    // On workspace switch, replace prior teams with that workspace’s cache while fetching.
    setAvailableTeams(cachedTeams ?? EMPTY_LINEAR_TEAMS)
    setLinearTeamsError(false)
    void listLinearTeams(selectedLinearWorkspaceId, {
      sourceContext: linearTaskSourceContext,
      force,
      // Why: the store otherwise resolves a failed read as an empty list, which reads as "no teams".
      rejectReadError: true
    })
      .then((teams) => {
        if (!cancelled) {
          setAvailableTeams(teams)
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setLinearTeamsError(true)
          console.warn('[TaskPage] Failed to fetch Linear teams', reason)
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    taskSource,
    linearConnected,
    selectedLinearWorkspaceId,
    linearTeamRefreshNonce,
    taskResumeApplied,
    getCachedLinearTeams,
    listLinearTeams,
    linearTaskSourceContext
  ])
  const retryLinearTeams = useCallback(() => setLinearTeamRefreshNonce((n) => n + 1), [])
  const jiraProjectsEnabled = taskResumeApplied && taskSource === 'jira' && jiraConnected
  // Why scope-keyed: a refresh must keep the last list, while a site or host change must drop it.
  const jiraProjectsScopeKey = JSON.stringify([
    taskSource,
    jiraConnected,
    selectedJiraSiteId,
    jiraTaskSourceScopeKey
  ])
  const [jiraProjectsSnapshot, setJiraProjectsSnapshot] = useState<JiraProjectsSnapshot | null>(
    null
  )
  const [jiraProjectsRefreshNonce, setJiraProjectsRefreshNonce] = useState(0)
  const [jiraProjectsLoadingScopeKey, setJiraProjectsLoadingScopeKey] = useState<string | null>(
    null
  )
  useEffect(() => {
    if (!jiraProjectsEnabled) {
      return
    }
    let cancelled = false
    setJiraProjectsLoadingScopeKey(jiraProjectsScopeKey)
    void jiraListProjects(jiraTaskSourceContext ?? defaultScopeHost(settings), selectedJiraSiteId)
      .then((projects) => {
        if (!cancelled) {
          setJiraProjectsSnapshot({ scopeKey: jiraProjectsScopeKey, projects, failed: false })
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          // Why: a failed refresh keeps the last known list so creation stays available.
          setJiraProjectsSnapshot((previous) => ({
            scopeKey: jiraProjectsScopeKey,
            projects:
              previous?.scopeKey === jiraProjectsScopeKey ? previous.projects : EMPTY_JIRA_PROJECTS,
            failed: true
          }))
          console.warn('[TaskPage] Failed to fetch Jira projects', reason)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setJiraProjectsLoadingScopeKey((current) =>
            current === jiraProjectsScopeKey ? null : current
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    settings,
    jiraProjectsEnabled,
    jiraProjectsScopeKey,
    jiraProjectsRefreshNonce,
    selectedJiraSiteId,
    jiraTaskSourceContext
  ])
  const retryJiraProjects = useCallback(() => setJiraProjectsRefreshNonce((n) => n + 1), [])
  const jiraProjectsInScope =
    jiraProjectsEnabled && jiraProjectsSnapshot?.scopeKey === jiraProjectsScopeKey
      ? jiraProjectsSnapshot
      : null
  const availableJiraProjects = jiraProjectsInScope?.projects ?? EMPTY_JIRA_PROJECTS
  const jiraProjectsError = jiraProjectsInScope?.failed ?? false
  // Why: only unknown projects disable creation; a background refresh keeps the picker usable.
  const jiraProjectsLoading =
    jiraProjectsEnabled &&
    jiraProjectsLoadingScopeKey === jiraProjectsScopeKey &&
    availableJiraProjects.length === 0

  // Why: fetch GitLab Issues and MRs separately so errors stay isolated per tab (mirrors GitHub's split endpoints).
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every added field is assigned below before the model is returned.
  const nextModel = model as typeof model & {
    availableTeams: typeof availableTeams
    setAvailableTeams: typeof setAvailableTeams
    linearTeamRefreshNonce: typeof linearTeamRefreshNonce
    setLinearTeamRefreshNonce: typeof setLinearTeamRefreshNonce
    linearTeamsError: typeof linearTeamsError
    retryLinearTeams: typeof retryLinearTeams
    availableJiraProjects: typeof availableJiraProjects
    jiraProjectsLoading: typeof jiraProjectsLoading
    jiraProjectsError: typeof jiraProjectsError
    retryJiraProjects: typeof retryJiraProjects
  }
  nextModel.availableTeams = availableTeams
  nextModel.setAvailableTeams = setAvailableTeams
  nextModel.linearTeamRefreshNonce = linearTeamRefreshNonce
  nextModel.setLinearTeamRefreshNonce = setLinearTeamRefreshNonce
  nextModel.linearTeamsError = linearTeamsError
  nextModel.retryLinearTeams = retryLinearTeams
  nextModel.availableJiraProjects = availableJiraProjects
  nextModel.jiraProjectsLoading = jiraProjectsLoading
  nextModel.jiraProjectsError = jiraProjectsError
  nextModel.retryJiraProjects = retryJiraProjects
  return nextModel
}
export type TaskPageProviderMetadataModel = ReturnType<typeof useTaskPageProviderMetadata>
