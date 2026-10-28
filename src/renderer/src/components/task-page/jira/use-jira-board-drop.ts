import { useRef, useState } from 'react'
import type { DragEvent } from 'react'
import type {
  JiraBoardColumn,
  JiraIssue,
  JiraTransition
} from '../../../../../shared/jira/jira-types'
import type { TaskPageJiraBoardColumn } from '../../task-page-jira-board-model'
import { getTaskPageJiraBoardTransitionTargets } from '../../task-page-jira-board-model'
import {
  classifyTransitionRequirements,
  rejectedTransitionFieldKeys
} from '../../../../../shared/jira/jira-transition-fields'
import { jiraListTransitions } from '@/runtime/runtime-jira-client'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-client'
import { translate } from '@/i18n/i18n'
import { toast } from 'sonner'
import { useJiraBoardTransitionMove } from './use-jira-board-transition-move'
import { jiraBoardErrorText } from './jira-board-error-text'

function columnKey(column: JiraBoardColumn, index: number): string {
  return `${column.name}:${index}:${column.statusIds.join(',')}`
}

/**
 * The board's drop flow. Every drop ends in an outcome: a move, a status picker,
 * a fields prompt, or a Jira-derived reason. The move itself (and its optimistic
 * patch and rollback) lives in `useJiraBoardTransitionMove`.
 */
export function useJiraBoardDrop({
  providerSettings,
  sprintIssues,
  columns,
  applyIssuePatch,
  revalidateBoard,
  onIssueMoved
}: {
  providerSettings: RuntimeJiraSettings
  sprintIssues: JiraIssue[]
  columns: TaskPageJiraBoardColumn[]
  applyIssuePatch: (key: string, patch: Partial<JiraIssue>, siteId?: string | null) => void
  revalidateBoard: () => void
  onIssueMoved: (issue: JiraIssue) => void
}) {
  const move = useJiraBoardTransitionMove({
    providerSettings,
    applyIssuePatch,
    revalidateBoard,
    onIssueMoved
  })
  const [draggingIssueKey, setDraggingIssueKey] = useState<string | null>(null)
  const [dragOverColumnKey, setDragOverColumnKey] = useState<string | null>(null)
  const [pendingIssue, setPendingIssue] = useState<JiraIssue | null>(null)
  const [pendingTransitions, setPendingTransitions] = useState<JiraTransition[]>([])
  const [pendingTransitionMode, setPendingTransitionMode] = useState<'column' | 'otherStatuses'>(
    'column'
  )
  // Why a ref, not the moving list: a second drop can fire before the first
  // transition lookup has resolved, and state updates are not synchronous there.
  const dropsInFlightRef = useRef(new Set<string>())

  const clearPicker = (): void => {
    setPendingIssue(null)
    setPendingTransitions([])
  }

  /** A transition that needs its screen fields asks for them before submitting. */
  const resolveTransition = async (issue: JiraIssue, transition: JiraTransition): Promise<void> => {
    if (classifyTransitionRequirements(transition).kind !== 'none') {
      clearPicker()
      move.openTransitionFields(issue, transition)
      return
    }
    const outcome = await move.applyTransition(issue, transition)
    if (outcome.ok) {
      clearPicker()
      return
    }
    // Why reopened: Jira named fields it refused, so they have to be asked for rather
    // than reported as a sentence with no control behind it.
    const forced = rejectedTransitionFieldKeys(transition, outcome.fieldErrors)
    if (forced.size > 0) {
      clearPicker()
      move.openTransitionFields(issue, transition, {
        rejectedFieldErrors: outcome.fieldErrors,
        errorMessages: outcome.errorMessages,
        error: outcome.error
      })
      return
    }
    toast.error(outcome.error)
  }

  const loadTransitions = async (issue: JiraIssue): Promise<JiraTransition[] | null> => {
    try {
      return await jiraListTransitions(providerSettings, issue.key, issue.siteId)
    } catch (error) {
      toast.error(jiraBoardErrorText(error))
      return null
    }
  }

  /** Clears the drag state and returns the dropped issue, or null when there is
   *  nothing to move. An issue already in flight says so instead of being ignored. */
  const takeDroppedIssue = (event: DragEvent<HTMLElement>): JiraIssue | null => {
    event.preventDefault()
    event.stopPropagation()
    setDragOverColumnKey(null)
    const issueKey = event.dataTransfer.getData('text/plain') || draggingIssueKey
    setDraggingIssueKey(null)
    if (!issueKey) {
      return null
    }
    const issue = sprintIssues.find((candidate) => candidate.key === issueKey)
    if (!issue) {
      return null
    }
    if (move.movingIssueKeys.includes(issue.key) || dropsInFlightRef.current.has(issue.key)) {
      toast.message(
        translate('auto.components.TaskPage.jiraBoardIssueMoving', '{{value0}} is still moving.', {
          value0: issue.key
        })
      )
      return null
    }
    dropsInFlightRef.current.add(issue.key)
    return issue
  }

  const runColumnDrop = async (column: JiraBoardColumn, issue: JiraIssue): Promise<void> => {
    if (column.statusIds.includes(issue.status.id)) {
      toast.message(
        translate(
          'auto.components.TaskPage.jiraBoardAlreadyInColumn',
          '{{value0}} is already in {{value1}}.',
          { value0: issue.key, value1: column.name }
        )
      )
      return
    }
    const transitions = await loadTransitions(issue)
    if (!transitions) {
      return
    }
    const matchingTransitions = getTaskPageJiraBoardTransitionTargets(transitions, column.statusIds)
    if (matchingTransitions.length === 0) {
      if (transitions.length === 0) {
        toast.error(
          translate(
            'auto.components.TaskPage.jiraNoAvailableTransitions',
            'Jira lists no available transitions for {{value0}}; the issue may be closed or you may lack permission.',
            { value0: issue.key }
          )
        )
      } else {
        toast.error(
          translate(
            'auto.components.TaskPage.jiraNoStatusTransitionAvailable',
            'Jira cannot move {{value0}} to {{value1}}. Available moves: {{value2}}.',
            {
              value0: issue.key,
              value1: column.name,
              value2: transitions.map((transition) => transition.to.name).join(', ')
            }
          )
        )
      }
      return
    }
    if (matchingTransitions.length === 1) {
      await resolveTransition(issue, matchingTransitions[0])
      return
    }
    setPendingTransitionMode('column')
    setPendingIssue(issue)
    setPendingTransitions(matchingTransitions)
  }

  const handleDrop = async (
    column: JiraBoardColumn,
    event: DragEvent<HTMLElement>
  ): Promise<void> => {
    const issue = takeDroppedIssue(event)
    if (!issue) {
      return
    }
    try {
      await runColumnDrop(column, issue)
    } finally {
      dropsInFlightRef.current.delete(issue.key)
    }
  }

  /**
   * "Other statuses" spans several statuses, so it is not a lane: the only
   * truthful move is to a status no column owns, chosen explicitly.
   */
  const runOtherDrop = async (issue: JiraIssue): Promise<void> => {
    const transitions = await loadTransitions(issue)
    if (!transitions) {
      return
    }
    const columnStatusIds = new Set(columns.flatMap((entry) => entry.column.statusIds))
    const otherTransitions = transitions.filter(
      (transition) => !columnStatusIds.has(transition.to.id)
    )
    if (otherTransitions.length === 0) {
      toast.error(
        translate(
          'auto.components.TaskPage.jiraNoOtherStatusTransition',
          'Jira has no move from {{value0}} to a status outside the board columns.',
          { value0: issue.key }
        )
      )
      return
    }
    if (otherTransitions.length === 1) {
      await resolveTransition(issue, otherTransitions[0])
      return
    }
    setPendingTransitionMode('otherStatuses')
    setPendingIssue(issue)
    setPendingTransitions(otherTransitions)
  }

  const handleOtherDrop = async (event: DragEvent<HTMLElement>): Promise<void> => {
    const issue = takeDroppedIssue(event)
    if (!issue) {
      return
    }
    try {
      await runOtherDrop(issue)
    } finally {
      dropsInFlightRef.current.delete(issue.key)
    }
  }

  return {
    draggingIssueKey,
    dragOverColumnKey,
    movingIssueKeys: move.movingIssueKeys,
    transitionSaving: move.transitionSaving,
    pendingIssue,
    pendingTransitions,
    pendingTransitionMode,
    pendingTransitionFields: move.pendingTransitionFields,
    submitTransitionFields: move.submitTransitionFields,
    startDrag: (issue: JiraIssue, event: DragEvent<HTMLDivElement>) => {
      if (move.movingIssueKeys.includes(issue.key)) {
        event.preventDefault()
        return
      }
      try {
        event.dataTransfer.setData('text/plain', issue.key)
        event.dataTransfer.effectAllowed = 'move'
        setDraggingIssueKey(issue.key)
      } catch {
        event.preventDefault()
      }
    },
    endDrag: () => {
      setDraggingIssueKey(null)
      setDragOverColumnKey(null)
    },
    handleDragOver: (columnGroup: TaskPageJiraBoardColumn, event: DragEvent<HTMLElement>) => {
      const index = columns.findIndex((entry) => entry.column === columnGroup.column)
      if (index === -1 || columnGroup.column.statusIds.length === 0) {
        return
      }
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setDragOverColumnKey(columnKey(columnGroup.column, index))
    },
    handleDragOverOther: (event: DragEvent<HTMLElement>) => {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setDragOverColumnKey('other')
    },
    handleDrop,
    handleOtherDrop,
    selectTransition: (transition: JiraTransition) => {
      if (pendingIssue) {
        void resolveTransition(pendingIssue, transition)
      }
    },
    closeTransitionPicker: () => {
      if (!move.transitionSaving) {
        clearPicker()
      }
    },
    closeTransitionFields: move.closeTransitionFields
  }
}
