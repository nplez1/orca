import { useCallback, useEffect, useRef, useState } from 'react'
import {
  jiraListAssignableUsers,
  jiraListPriorities,
  jiraListTransitions
} from '@/runtime/runtime-jira-client'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-target'
import type { JiraPriority, JiraTransition, JiraUser } from '../../../shared/jira-types'

export type JiraIssueSideDataState = {
  transitions: JiraTransition[]
  priorities: JiraPriority[]
  users: JiraUser[]
  reloadTransitions: () => Promise<void>
}

/** Transitions, priorities, and assignable users for one Jira issue. Keyed on
 *  the issue key + site so a refresh of the same issue does not re-run these. */
export function useJiraIssueSideData({
  providerSettings,
  issueKey,
  issueSiteId
}: {
  providerSettings: RuntimeJiraSettings
  issueKey: string | null
  issueSiteId: string | undefined
}): JiraIssueSideDataState {
  const [transitions, setTransitions] = useState<JiraTransition[]>([])
  const [priorities, setPriorities] = useState<JiraPriority[]>([])
  const [users, setUsers] = useState<JiraUser[]>([])
  const requestIdRef = useRef(0)

  useEffect(() => {
    if (!issueKey) {
      setTransitions([])
      setPriorities([])
      setUsers([])
      return
    }
    const requestId = ++requestIdRef.current
    void Promise.all([
      jiraListTransitions(providerSettings, issueKey, issueSiteId),
      jiraListPriorities(providerSettings, issueSiteId),
      jiraListAssignableUsers(providerSettings, issueKey, undefined, issueSiteId)
    ])
      .then(([nextTransitions, nextPriorities, nextUsers]) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        setTransitions(nextTransitions)
        setPriorities(nextPriorities)
        setUsers(nextUsers)
      })
      .catch(() => {})
  }, [issueKey, issueSiteId, providerSettings])

  const reloadTransitions = useCallback(async (): Promise<void> => {
    if (!issueKey) {
      return
    }
    const next = await jiraListTransitions(providerSettings, issueKey, issueSiteId).catch(
      () => null
    )
    if (next) {
      setTransitions(next)
    }
  }, [issueKey, issueSiteId, providerSettings])

  return { transitions, priorities, users, reloadTransitions }
}
