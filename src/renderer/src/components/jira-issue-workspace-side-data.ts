import { useCallback, useEffect, useRef, useState } from 'react'
import {
  jiraListAssignableUsers,
  jiraListEditFields,
  jiraListPriorities,
  jiraListTransitions
} from '@/runtime/runtime-jira-client'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-target'
import type {
  JiraEditableField,
  JiraPriority,
  JiraTransition,
  JiraUser
} from '../../../shared/jira-types'

export type JiraIssueSideDataState = {
  transitions: JiraTransition[]
  priorities: JiraPriority[]
  users: JiraUser[]
  /** Custom fields Jira allows this user to edit on the issue, with values. */
  editFields: JiraEditableField[]
  editFieldsLoading: boolean
  reloadTransitions: () => Promise<void>
  reloadEditFields: () => Promise<void>
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
  const [editFields, setEditFields] = useState<JiraEditableField[]>([])
  const [editFieldsLoading, setEditFieldsLoading] = useState(false)
  const requestIdRef = useRef(0)
  // Why a key ref rather than the request counter: a reload for the old issue
  // must be dropped without also discarding the new issue's in-flight load.
  const editFieldsIssueKeyRef = useRef<string | null>(issueKey)

  useEffect(() => {
    editFieldsIssueKeyRef.current = issueKey
  }, [issueKey])

  useEffect(() => {
    if (!issueKey) {
      setTransitions([])
      setPriorities([])
      setUsers([])
      setEditFields([])
      setEditFieldsLoading(false)
      return
    }
    const requestId = ++requestIdRef.current
    setEditFieldsLoading(true)
    void Promise.all([
      jiraListTransitions(providerSettings, issueKey, issueSiteId),
      jiraListPriorities(providerSettings, issueSiteId),
      jiraListAssignableUsers(providerSettings, issueKey, undefined, issueSiteId),
      jiraListEditFields(providerSettings, issueKey, issueSiteId).catch(() => [])
    ])
      .then(([nextTransitions, nextPriorities, nextUsers, nextEditFields]) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        setTransitions(nextTransitions)
        setPriorities(nextPriorities)
        setUsers(nextUsers)
        setEditFields(nextEditFields)
      })
      .catch(() => {})
      .finally(() => {
        if (requestId === requestIdRef.current) {
          setEditFieldsLoading(false)
        }
      })
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

  const reloadEditFields = useCallback(async (): Promise<void> => {
    if (!issueKey) {
      return
    }
    const requestedKey = issueKey
    const next = await jiraListEditFields(providerSettings, requestedKey, issueSiteId).catch(
      () => null
    )
    if (next && editFieldsIssueKeyRef.current === requestedKey) {
      setEditFields(next)
    }
  }, [issueKey, issueSiteId, providerSettings])

  return {
    transitions,
    priorities,
    users,
    editFields,
    editFieldsLoading,
    reloadTransitions,
    reloadEditFields
  }
}
