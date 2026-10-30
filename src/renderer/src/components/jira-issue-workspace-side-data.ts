import { useCallback, useEffect, useRef, useState } from 'react'
import {
  jiraGetIssueSprintAssignment,
  jiraListAssignableUsers,
  jiraListEditFields,
  jiraListPriorities,
  jiraListTransitions
} from '@/runtime/runtime-jira-client'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-target'
import {
  describeJiraSideReadFailure,
  EDIT_FIELDS_READ_FAILED,
  PRIORITIES_READ_FAILED,
  SPRINT_READ_FAILED,
  TRANSITIONS_READ_FAILED,
  USERS_READ_FAILED
} from './jira-issue-side-read-error'
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
  /** Why an error per read: an empty list and a failed read look identical on screen,
   *  and "No users found" for a request nobody answered is a false claim. */
  prioritiesError: string | null
  users: JiraUser[]
  usersError: string | null
  /** Custom fields Jira allows this user to edit on the issue, with values. */
  editFields: JiraEditableField[]
  editFieldsLoading: boolean
  editFieldsError: string | null
  sprintAssignment: JiraSprintAssignment | null
  sprintAssignmentError: string | null
  reloadTransitions: () => Promise<void>
  reloadEditFields: () => Promise<void>
  reloadSprintAssignment: () => Promise<void>
  /** Optimistic local move, so the picker does not lag the request. */
  selectSprint: (sprintId: string | null) => void
  /** Puts back an assignment captured before a move whose request failed. */
  restoreSprintAssignment: (assignment: JiraSprintAssignment | null) => void
}

/** The assignment read for one issue, keyed so a switch cannot show the previous one's. */
type SprintAssignmentState = {
  issueKey: string
  /** Null once a move rolled back to a state with nothing to offer. */
  assignment: JiraSprintAssignment | null
}

/** An assignment with no current sprint and nothing to move into reads as no control. */
function offerable(assignment: JiraSprintAssignment | null): JiraSprintAssignment | null {
  return assignment?.sprint || assignment?.sprints.length ? assignment : null
}

/** Transitions, priorities, assignable users, editable custom fields, and the sprint
 *  assignment for one issue, keyed so a refresh of the same issue does not re-run them. */
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
  const [prioritiesError, setPrioritiesError] = useState<string | null>(null)
  const [users, setUsers] = useState<JiraUser[]>([])
  const [usersError, setUsersError] = useState<string | null>(null)
  const [editFields, setEditFields] = useState<JiraEditableField[]>([])
  const [editFieldsLoading, setEditFieldsLoading] = useState(false)
  const [editFieldsError, setEditFieldsError] = useState<string | null>(null)
  const [sprintAssignmentError, setSprintAssignmentError] = useState<string | null>(null)
  const [sprintState, setSprintState] = useState<SprintAssignmentState | null>(null)
  const requestIdRef = useRef(0)
  // Fences a reload against an in-flight initial read so a stale list cannot
  // overwrite the freshly reloaded one.
  const transitionsReadIdRef = useRef(0)
  // Why a key ref rather than the request counter: a reload for the old issue
  // must be dropped without also discarding the new issue's in-flight load.
  const issueKeyRef = useRef<string | null>(issueKey)
  // Why keyed on the issue: switching issues must not show the previous one's sprint,
  // and a read still in flight for it must not land on the new one.
  const sprintAssignment =
    sprintState?.issueKey === issueKey ? offerable(sprintState.assignment) : null

  useEffect(() => {
    issueKeyRef.current = issueKey
  }, [issueKey])

  useEffect(() => {
    if (!issueKey) {
      setTransitions([])
      setTransitionsLoading(false)
      setTransitionsError(null)
      setPriorities([])
      setPrioritiesError(null)
      setUsers([])
      setUsersError(null)
      setEditFields([])
      setEditFieldsLoading(false)
      setEditFieldsError(null)
      setSprintAssignmentError(null)
      setSprintState(null)
      return
    }
    const requestId = ++requestIdRef.current
    // Why increment: a reload or post-transition re-read for the previous issue must
    // not land its transitions, loading flag or error on the issue now selected, so
    // each effect run claims its own read id rather than sharing the last one.
    const transitionsReadId = ++transitionsReadIdRef.current
    const current = (): boolean => requestId === requestIdRef.current
    // Clear the previous issue's data so it cannot linger while the new read runs.
    setTransitions([])
    setTransitionsLoading(true)
    setTransitionsError(null)
    setPriorities([])
    setPrioritiesError(null)
    setUsers([])
    setUsersError(null)
    setEditFields([])
    setEditFieldsLoading(true)
    setEditFieldsError(null)
    setSprintAssignmentError(null)
    void Promise.all([
      jiraListTransitions(providerSettings, issueKey, issueSiteId).catch(
        (error): JiraTransition[] => {
          if (current() && transitionsReadId === transitionsReadIdRef.current) {
            setTransitionsError(describeJiraSideReadFailure(error, ...TRANSITIONS_READ_FAILED))
          }
          return []
        }
      ),
      // Why the strict reads and the named failures: a priorities, users or field
      // read that fails is not the same answer as a site that offers none, and the
      // surfaces below would otherwise say "none" for a request nobody answered.
      jiraListPriorities(providerSettings, issueSiteId, true).catch((error): JiraPriority[] => {
        if (current()) {
          setPrioritiesError(describeJiraSideReadFailure(error, ...PRIORITIES_READ_FAILED))
        }
        return []
      }),
      jiraListAssignableUsers(providerSettings, issueKey, undefined, issueSiteId, true).catch(
        (error): JiraUser[] => {
          if (current()) {
            setUsersError(describeJiraSideReadFailure(error, ...USERS_READ_FAILED))
          }
          return []
        }
      ),
      jiraListEditFields(providerSettings, issueKey, issueSiteId, true).catch(
        (error): JiraEditableField[] => {
          if (current()) {
            setEditFieldsError(describeJiraSideReadFailure(error, ...EDIT_FIELDS_READ_FAILED))
          }
          return []
        }
      ),
      sprintBoardId
        ? jiraGetIssueSprintAssignment(
            providerSettings,
            issueKey,
            issueSiteId,
            sprintBoardId
          ).catch((error): JiraSprintAssignment | null => {
            if (current()) {
              setSprintAssignmentError(describeJiraSideReadFailure(error, ...SPRINT_READ_FAILED))
            }
            return null
          })
        : Promise.resolve(null)
    ])
      .then(
        ([nextTransitions, nextPriorities, nextUsers, nextEditFields, nextSprintAssignment]) => {
          if (!current()) {
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
        if (current()) {
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
        setTransitionsError(describeJiraSideReadFailure(error, ...TRANSITIONS_READ_FAILED))
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
    setEditFieldsLoading(true)
    setEditFieldsError(null)
    try {
      const next = await jiraListEditFields(providerSettings, requestedKey, issueSiteId, true)
      if (issueKeyRef.current === requestedKey) {
        setEditFields(next)
      }
    } catch (error) {
      if (issueKeyRef.current === requestedKey) {
        setEditFieldsError(describeJiraSideReadFailure(error, ...EDIT_FIELDS_READ_FAILED))
      }
    } finally {
      if (issueKeyRef.current === requestedKey) {
        setEditFieldsLoading(false)
      }
    }
  }, [issueKey, issueSiteId, providerSettings])

  const reloadSprintAssignment = useCallback(async (): Promise<void> => {
    if (!issueKey || !sprintBoardId) {
      return
    }
    const requestedKey = issueKey
    try {
      const next = await jiraGetIssueSprintAssignment(
        providerSettings,
        requestedKey,
        issueSiteId,
        sprintBoardId
      )
      // Why by key: a reload issued for one issue must not overwrite the next one's.
      // Why only a non-null answer: a host that cannot answer (no board method, or a
      // failed read) must leave the assignment a rollback already put back.
      if (next) {
        setSprintState((currentState) =>
          currentState && currentState.issueKey !== requestedKey
            ? currentState
            : { issueKey: requestedKey, assignment: next }
        )
      }
      if (issueKeyRef.current === requestedKey && next) {
        setSprintAssignmentError(null)
      }
    } catch (error) {
      if (issueKeyRef.current === requestedKey) {
        setSprintAssignmentError(describeJiraSideReadFailure(error, ...SPRINT_READ_FAILED))
      }
    }
  }, [issueKey, issueSiteId, providerSettings, sprintBoardId])

  const selectSprint = useCallback(
    (sprintId: string | null): void => {
      setSprintState((currentState) => {
        if (!currentState || currentState.issueKey !== issueKey || !currentState.assignment) {
          return currentState
        }
        const { assignment } = currentState
        return {
          issueKey: currentState.issueKey,
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
    prioritiesError,
    users,
    usersError,
    editFields,
    editFieldsLoading,
    editFieldsError,
    sprintAssignment,
    sprintAssignmentError,
    reloadTransitions,
    reloadEditFields,
    reloadSprintAssignment,
    selectSprint,
    restoreSprintAssignment
  }
}
