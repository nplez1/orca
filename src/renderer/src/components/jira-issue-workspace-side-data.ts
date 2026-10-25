import { useCallback, useEffect, useRef, useState } from 'react'
import {
  jiraGetIssueSprintAssignment,
  jiraListAssignableUsers,
  jiraListEditFields,
  jiraListPriorities,
  jiraListTransitions
} from '@/runtime/runtime-jira-client'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-target'
import type {
  JiraEditableField,
  JiraPriority,
  JiraSprintAssignment,
  JiraTransition,
  JiraUser
} from '../../../shared/jira/jira-types'

export type JiraIssueSideDataState = {
  transitions: JiraTransition[]
  transitionsLoading: boolean
  transitionsError: string | null
  priorities: JiraPriority[]
  users: JiraUser[]
  /** Custom fields Jira allows this user to edit on the issue, with values. */
  editFields: JiraEditableField[]
  editFieldsLoading: boolean
  sprintAssignment: JiraSprintAssignment | null
  reloadTransitions: () => Promise<void>
  reloadEditFields: () => Promise<void>
  reloadSprintAssignment: () => Promise<void>
  /** Optimistic local move, so the picker does not lag the request. */
  selectSprint: (sprintId: string | null) => void
  /** Puts back an assignment captured before a move whose request failed. */
  restoreSprintAssignment: (assignment: JiraSprintAssignment | null) => void
}

/** An assignment with no current sprint and nothing to move into reads as no control. */
function offerableAssignment(assignment: JiraSprintAssignment | null): JiraSprintAssignment | null {
  if (!assignment) {
    return null
  }
  return assignment.sprint || assignment.sprints.length > 0 ? assignment : null
}

/** The assignment read for one issue, keyed so a switch cannot show the previous one's. */
type SprintAssignmentState = {
  issueKey: string
  /** Null once a move rolled back to a state with nothing to offer. */
  assignment: JiraSprintAssignment | null
}

/** Transitions, priorities, assignable users, editable custom fields, and the sprint
 *  assignment for one Jira issue. Keyed on the issue key + site so a refresh of the
 *  same issue does not re-run these. */
export function useJiraIssueSideData({
  providerSettings,
  issueKey,
  issueSiteId,
  sprintBoardId
}: {
  providerSettings: RuntimeJiraSettings
  issueKey: string | null
  issueSiteId: string | undefined
  /** Board whose sprints the issue can be moved into; omitted where no board is
   *  in scope, which skips the request rather than asking for an empty list. */
  sprintBoardId?: string | null
}): JiraIssueSideDataState {
  const [transitions, setTransitions] = useState<JiraTransition[]>([])
  const [transitionsLoading, setTransitionsLoading] = useState(false)
  const [transitionsError, setTransitionsError] = useState<string | null>(null)
  const [priorities, setPriorities] = useState<JiraPriority[]>([])
  const [users, setUsers] = useState<JiraUser[]>([])
  const [editFields, setEditFields] = useState<JiraEditableField[]>([])
  const [editFieldsLoading, setEditFieldsLoading] = useState(false)
  const [sprintState, setSprintState] = useState<SprintAssignmentState | null>(null)
  const requestIdRef = useRef(0)
  // Fences a reload against an in-flight initial read so a stale list cannot
  // overwrite the freshly reloaded one.
  const transitionsReadIdRef = useRef(0)
  // Why a key ref rather than the request counter: a reload for the old issue
  // must be dropped without also discarding the new issue's in-flight load.
  const editFieldsIssueKeyRef = useRef<string | null>(issueKey)
  // Why keyed on the issue: switching issues must not show the previous one's sprint,
  // and a read still in flight for it must not land on the new one.
  const sprintAssignment =
    sprintState?.issueKey === issueKey ? offerableAssignment(sprintState.assignment) : null

  useEffect(() => {
    editFieldsIssueKeyRef.current = issueKey
  }, [issueKey])

  useEffect(() => {
    if (!issueKey) {
      setTransitions([])
      setTransitionsLoading(false)
      setTransitionsError(null)
      setPriorities([])
      setUsers([])
      setEditFields([])
      setEditFieldsLoading(false)
      setSprintState(null)
      return
    }
    const requestId = ++requestIdRef.current
    // Why increment: a reload or post-transition re-read for the previous issue must
    // not land its transitions, loading flag or error on the issue now selected, so
    // each effect run claims its own read id rather than sharing the last one.
    const transitionsReadId = ++transitionsReadIdRef.current
    // Clear the previous issue's data so it cannot linger while the new read runs.
    setTransitions([])
    setTransitionsLoading(true)
    setTransitionsError(null)
    setPriorities([])
    setUsers([])
    setEditFields([])
    setEditFieldsLoading(true)
    void Promise.all([
      jiraListTransitions(providerSettings, issueKey, issueSiteId).catch(
        (error): JiraTransition[] => {
          if (
            requestId === requestIdRef.current &&
            transitionsReadId === transitionsReadIdRef.current
          ) {
            setTransitionsError(
              error instanceof Error ? error.message : 'Failed to load status changes.'
            )
          }
          return []
        }
      ),
      // Why the local catches: a priorities or assignable-users failure must not
      // reject the whole Promise.all and silently blank the transitions list.
      jiraListPriorities(providerSettings, issueSiteId).catch(() => []),
      jiraListAssignableUsers(providerSettings, issueKey, undefined, issueSiteId).catch(() => []),
      jiraListEditFields(providerSettings, issueKey, issueSiteId).catch(() => []),
      // Why the local catch: sprint assignment is optional next to the fields above,
      // so a read that fails must not blank them all.
      sprintBoardId
        ? jiraGetIssueSprintAssignment(
            providerSettings,
            issueKey,
            issueSiteId,
            sprintBoardId
          ).catch(() => null)
        : Promise.resolve(null)
    ])
      .then(
        ([nextTransitions, nextPriorities, nextUsers, nextEditFields, nextSprintAssignment]) => {
          if (requestId !== requestIdRef.current) {
            return
          }
          if (transitionsReadId === transitionsReadIdRef.current) {
            setTransitions(nextTransitions)
            setTransitionsLoading(false)
          }
          setPriorities(nextPriorities)
          setUsers(nextUsers)
          setEditFields(nextEditFields)
          setSprintState({ issueKey, assignment: nextSprintAssignment })
        }
      )
      .catch(() => {})
      .finally(() => {
        if (requestId === requestIdRef.current) {
          setEditFieldsLoading(false)
          if (transitionsReadId === transitionsReadIdRef.current) {
            setTransitionsLoading(false)
          }
        }
      })
  }, [issueKey, issueSiteId, providerSettings, sprintBoardId])

  const reloadTransitions = useCallback(async (): Promise<void> => {
    if (!issueKey) {
      return
    }
    const readId = ++transitionsReadIdRef.current
    setTransitionsLoading(true)
    setTransitionsError(null)
    try {
      const next = await jiraListTransitions(providerSettings, issueKey, issueSiteId)
      if (readId === transitionsReadIdRef.current) {
        setTransitions(next)
      }
    } catch (error) {
      if (readId === transitionsReadIdRef.current) {
        setTransitionsError(
          error instanceof Error ? error.message : 'Failed to load status changes.'
        )
      }
    } finally {
      if (readId === transitionsReadIdRef.current) {
        setTransitionsLoading(false)
      }
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

  const reloadSprintAssignment = useCallback(async (): Promise<void> => {
    if (!issueKey || !sprintBoardId) {
      return
    }
    const requestedKey = issueKey
    const next = await jiraGetIssueSprintAssignment(
      providerSettings,
      requestedKey,
      issueSiteId,
      sprintBoardId
    ).catch(() => null)
    // Why by key: a reload issued for one issue must not overwrite the next one's.
    if (next) {
      setSprintState((current) =>
        current && current.issueKey !== requestedKey
          ? current
          : { issueKey: requestedKey, assignment: next }
      )
    }
  }, [issueKey, issueSiteId, providerSettings, sprintBoardId])

  const selectSprint = useCallback(
    (sprintId: string | null): void => {
      setSprintState((current) => {
        if (!current || current.issueKey !== issueKey || !current.assignment) {
          return current
        }
        const { assignment } = current
        return {
          issueKey: current.issueKey,
          assignment: {
            ...assignment,
            sprint: assignment.sprints.find((sprint) => sprint.id === sprintId) ?? null
          }
        }
      })
    },
    [issueKey]
  )

  const restoreSprintAssignment = useCallback(
    (assignment: JiraSprintAssignment | null): void => {
      if (!issueKey) {
        return
      }
      // Why by key rather than by the current selection: this is the issue the move was
      // issued for, so a rollback after a switch writes an entry nobody reads.
      setSprintState({ issueKey, assignment })
    },
    [issueKey]
  )

  return {
    transitions,
    transitionsLoading,
    transitionsError,
    priorities,
    users,
    editFields,
    editFieldsLoading,
    sprintAssignment,
    reloadTransitions,
    reloadEditFields,
    reloadSprintAssignment,
    selectSprint,
    restoreSprintAssignment
  }
}
