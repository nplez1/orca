/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: Jira issue hydration, comments, transitions, priorities, and user options are loaded from provider IPC for the selected issue. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { jiraGetIssue, jiraUpdateIssue } from '@/runtime/runtime-jira-client'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-target'
import type { JiraFieldErrors, JiraIssue } from '../../../shared/jira-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'
import { useJiraIssueComments } from './jira-issue-workspace-comments'
import { useJiraIssueSideData } from './jira-issue-workspace-side-data'
import type { JiraIssueWorkspaceDetailState } from './jira-issue-workspace-detail-contract'


/** Hydrates the full detail set for one Jira issue and owns its mutations.
 *  Shared by the Task view's `JiraIssueWorkspace` and the right-sidebar Issue
 *  pane so both read and write through the same contract.
 *
 *  `fetchKey` lets a caller that only knows the issue key (the pane, reading a
 *  workspace's persisted link) hydrate from that key instead of handing over a
 *  full issue. Passing neither `issue` nor `fetchKey` resets the state. */
export function useJiraIssueWorkspaceDetail({
  issue,
  fetchKey = null,
  fetchSiteId = null,
  sprintBoard = null,
  providerSettings,
  sourceContext,
  refreshSignal = 0
}: {
  issue: JiraIssue | null
  fetchKey?: string | null
  /** The site the linked workspace already records. The host would otherwise pick
   *  from its own selected/active site, which is a different site whenever the
   *  user has more than one — the read then returns nothing for a valid key. */
  fetchSiteId?: string | null
  /** Board the issue's sprint can be changed on; omitted where no board is in scope. */
  sprintBoard?: { boardId: string; siteId: string } | null
  providerSettings: RuntimeJiraSettings
  sourceContext?: TaskSourceContext | null
  refreshSignal?: number
}): JiraIssueWorkspaceDetailState {
  const patchJiraIssue = useAppStore((s) => s.patchJiraIssue)
  const [fullIssue, setFullIssue] = useState<JiraIssue | null>(null)
  const [issueLoading, setIssueLoading] = useState(false)
  const [pendingField, setPendingField] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [labelsDraft, setLabelsDraft] = useState('')
  const [reloadSignal, setReloadSignal] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const issueRequestIdRef = useRef(0)
  const lastRefreshSignalRef = useRef(refreshSignal)

  const displayed = fullIssue ?? issue
  const siteId = displayed?.siteId ?? undefined
  const issueKey = displayed?.key ?? null
  // A board id only means something on its own site: an issue on another site would
  // have its siteless read and that board's sprint list served by different Jira
  // instances, so it gets no board until the two agree.
  const sprintBoardId =
    sprintBoard && displayed?.siteId === sprintBoard.siteId ? sprintBoard.boardId : null

  useEffect(() => {
    // Why: bump before the reset branch so an in-flight fetch cannot land on a cleared issue.
    const fetchRequestId = ++issueRequestIdRef.current
    if (!issue && !fetchKey) {
      setFullIssue(null)
      setIssueLoading(false)
      return
    }
    const seed = issue ?? null
    setFullIssue(seed)
    if (seed) {
      setTitleDraft(seed.title)
      setLabelsDraft(seed.labels.join(', '))
    }
    setIssueLoading(true)

    void jiraGetIssue(
      providerSettings,
      seed?.key ?? fetchKey!,
      seed?.siteId ?? fetchSiteId ?? undefined
    )
      .then((result) => {
        if (fetchRequestId !== issueRequestIdRef.current || !result) {
          return
        }
        setFullIssue(result)
        setTitleDraft(result.title)
        setLabelsDraft(result.labels.join(', '))
      })
      .catch(() => {})
      .finally(() => {
        if (fetchRequestId === issueRequestIdRef.current) {
          setIssueLoading(false)
        }
      })
  }, [issue, fetchKey, fetchSiteId, providerSettings, reloadSignal])

  const sideData = useJiraIssueSideData({
    providerSettings,
    issueKey,
    issueSiteId: siteId,
    sprintBoardId
  })
  const commentsState = useJiraIssueComments({ providerSettings, issueKey, issueSiteId: siteId })
  const reloadTransitions = sideData.reloadTransitions
  const reloadEditFields = sideData.reloadEditFields
  const reloadSprintAssignment = sideData.reloadSprintAssignment
  const restoreSprintAssignment = sideData.restoreSprintAssignment
  const selectSprint = sideData.selectSprint

  const refreshIssue = useCallback(async (): Promise<void> => {
    if (!displayed) {
      return
    }
    try {
      const latest = await jiraGetIssue(providerSettings, displayed.key, displayed.siteId)
      if (latest) {
        setFullIssue(latest)
        patchJiraIssue(latest.key, latest, { sourceContext })
      }
    } catch {
      // Keep the visible issue snapshot if refresh fails.
    }
  }, [displayed, patchJiraIssue, providerSettings, sourceContext])

  const refresh = useCallback(async (): Promise<void> => {
    if (!displayed) {
      return
    }
    setRefreshing(true)
    try {
      await refreshIssue()
      await reloadTransitions()
    } finally {
      setRefreshing(false)
    }
  }, [displayed, refreshIssue, reloadTransitions])

  useEffect(() => {
    if (lastRefreshSignalRef.current === refreshSignal) {
      return
    }
    lastRefreshSignalRef.current = refreshSignal
    void refresh()
  }, [refresh, refreshSignal])

  const mutateIssue = useCallback(
    async (
      field: string,
      updates: Parameters<typeof jiraUpdateIssue>[2],
      optimistic?: Partial<JiraIssue>
    ): Promise<void> => {
      if (!displayed || pendingField) {
        return
      }
      setPendingField(field)
      const previous = displayed
      const sprintChanged = updates.sprintId !== undefined
      const previousSprintAssignment = sideData.sprintAssignment
      try {
        if (optimistic) {
          setFullIssue({ ...displayed, ...optimistic })
          patchJiraIssue(displayed.key, optimistic, { sourceContext })
        }
        if (sprintChanged) {
          selectSprint(updates.sprintId ?? null)
        }
        const result = await jiraUpdateIssue(providerSettings, displayed.key, updates, siteId)
        if (!result.ok) {
          throw new Error(result.error)
        }
        await refreshIssue()
        if (sprintChanged) {
          await reloadSprintAssignment()
        }
      } catch (error) {
        setFullIssue(previous)
        patchJiraIssue(previous.key, previous, { sourceContext })
        if (sprintChanged) {
          // Why the local restore before the re-read: the fault that failed the move
          // usually fails that read too, and the picker must not keep showing a sprint
          // the issue never reached.
          restoreSprintAssignment(previousSprintAssignment)
          await reloadSprintAssignment()
        }
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.JiraIssueWorkspace.ea21952aa3',
                'Failed to update Jira issue.'
              )
        )
      } finally {
        setPendingField(null)
      }
    },
    [
      displayed,
      patchJiraIssue,
      pendingField,
      refreshIssue,
      providerSettings,
      reloadSprintAssignment,
      restoreSprintAssignment,
      selectSprint,
      sideData.sprintAssignment,
      siteId,
      sourceContext
    ]
  )

  const submitIssueFields = useCallback(
    async (
      updates: Parameters<typeof jiraUpdateIssue>[2]
    ): Promise<{ ok: true } | { ok: false; error: string; fieldErrors?: JiraFieldErrors }> => {
      if (!displayed) {
        return {
          ok: false,
          error: translate(
            'auto.components.JiraIssueWorkspace.noIssueSelected',
            'No Jira issue is selected.'
          )
        }
      }
      if (pendingField) {
        return {
          ok: false,
          error: translate(
            'auto.components.JiraIssueWorkspace.anotherUpdatePending',
            'Another Jira update is still in progress.'
          )
        }
      }
      setPendingField('fields')
      try {
        const result = await jiraUpdateIssue(providerSettings, displayed.key, updates, siteId)
        if (!result.ok) {
          return {
            ok: false,
            error: result.error,
            ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {})
          }
        }
        await refreshIssue()
        await reloadEditFields()
        return { ok: true }
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : translate(
                  'auto.components.JiraIssueWorkspace.ea21952aa3',
                  'Failed to update Jira issue.'
                )
        }
      } finally {
        setPendingField(null)
      }
    },
    [displayed, pendingField, providerSettings, refreshIssue, reloadEditFields, siteId]
  )

  const handleSaveTitle = useCallback(() => {
    if (!displayed) {
      return
    }
    const title = titleDraft.trim()
    if (!title || title === displayed.title) {
      setTitleDraft(displayed.title)
      return
    }
    void mutateIssue('title', { title }, { title })
  }, [displayed, mutateIssue, titleDraft])

  const handleSaveLabels = useCallback(() => {
    if (!displayed) {
      return
    }
    const labels = labelsDraft
      .split(',')
      .map((label) => label.trim())
      .filter(Boolean)
    void mutateIssue('labels', { labels }, { labels })
  }, [displayed, labelsDraft, mutateIssue])

  const reload = useCallback((): void => {
    setReloadSignal((current) => current + 1)
  }, [])

  return {
    displayed,
    issueLoading,
    comments: commentsState.comments,
    commentsLoading: commentsState.commentsLoading,
    commentsError: commentsState.commentsError,
    transitions: sideData.transitions,
    priorities: sideData.priorities,
    users: sideData.users,
    editFields: sideData.editFields,
    editFieldsLoading: sideData.editFieldsLoading,
    sprintAssignment: sideData.sprintAssignment,
    pendingField,
    titleDraft,
    setTitleDraft,
    labelsDraft,
    setLabelsDraft,
    commentDraft: commentsState.commentDraft,
    setCommentDraft: commentsState.setCommentDraft,
    commentSubmitting: commentsState.commentSubmitting,
    canSubmitComment: commentsState.canSubmitComment,
    handleSaveTitle,
    handleSaveLabels,
    handleSubmitComment: commentsState.handleSubmitComment,
    retryComments: commentsState.retryComments,
    refreshing,
    refresh,
    reload,
    mutateIssue,
    submitIssueFields
  }
}
