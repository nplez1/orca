/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: Jira issue hydration, comments, transitions, priorities, and user options are loaded from provider IPC for the selected issue. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { jiraGetIssue, jiraUpdateIssue } from '@/runtime/runtime-jira-client'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-target'
import type { JiraIssue } from '../../../shared/jira-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'
import { getJiraReadIdentity } from '@/store/slices/jira-read-coordination'
import { useJiraIssueComments } from './jira-issue-workspace-comments'
import { useJiraIssueSideData } from './jira-issue-workspace-side-data'
import type { JiraIssueWorkspaceDetailState } from './jira-issue-workspace-detail-contract'
import { enqueueJiraIssueMutation, jiraIssueRequestScope } from './jira-issue-mutation-queue'
import { useJiraIssueMutationState } from './use-jira-issue-mutation-state'
import { useJiraIssueWorkspaceRefresh } from './use-jira-issue-workspace-refresh'
import { submitJiraIssueFields } from './jira-issue-workspace-field-submission'
import {
  editedJiraIssueFields,
  mergeJiraIssueHydration,
  type EditableJiraIssueField
} from './jira-issue-workspace-hydration'

/** Hydrates one Jira issue and owns its mutations, shared by the Task view and
 *  the Issue pane. `fetchKey` hydrates from a bare key; neither input resets state. */
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
  /** The linked workspace's own site, so a valid key reads back from the right one. */
  fetchSiteId?: string | null
  /** Board the issue's sprint can be changed on; omitted where no board is in scope. */
  sprintBoard?: { boardId: string; siteId: string } | null
  providerSettings: RuntimeJiraSettings
  sourceContext?: TaskSourceContext | null
  refreshSignal?: number
}): JiraIssueWorkspaceDetailState {
  const settings = useAppStore((s) => s.settings)
  const patchJiraIssue = useAppStore((s) => s.patchJiraIssue)
  const [fullIssue, setFullIssue] = useState<JiraIssue | null>(null)
  const [issueLoading, setIssueLoading] = useState(false)
  const [pendingField, setPendingField] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [labelsDraft, setLabelsDraft] = useState('')
  const [reloadSignal, setReloadSignal] = useState(0)
  const issueRequestIdRef = useRef(0)
  const lastReloadSignalRef = useRef(reloadSignal)
  const loadedRequestKeyRef = useRef<string | null>(null)
  const editedFieldsRef = useRef(new Set<EditableJiraIssueField>())
  // Bumped whenever the mutation scope changes, so a save that settles after a
  // selection moved to another issue does not clear the new issue's pending field.
  const scopeGenerationRef = useRef(0)

  const displayed = fullIssue ?? issue
  const siteId = displayed?.siteId ?? undefined
  const issueKey = displayed?.key ?? null
  // A board only means something on its own site, so the two must agree first.
  const sprintBoardId =
    sprintBoard && displayed?.siteId === sprintBoard.siteId ? sprintBoard.boardId : null

  const requestKey = jiraIssueRequestScope(displayed, sourceContext, settings)
  // Key on the raw prop: the displayed issue stays the previous one for a render after a switch.
  const hydrationScopeKey = jiraIssueRequestScope(issue, sourceContext, settings)
  const mutationContextKey = getJiraReadIdentity(settings, sourceContext).contextKey

  useEffect(() => {
    const reloadRequested = lastReloadSignalRef.current !== reloadSignal
    lastReloadSignalRef.current = reloadSignal
    // Why skip: an optimistic patch hands a new object for the same key/site and must not re-hydrate.
    if (issue && !reloadRequested && loadedRequestKeyRef.current === hydrationScopeKey) {
      return
    }
    loadedRequestKeyRef.current = hydrationScopeKey
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
        const edited = new Set(editedFieldsRef.current)
        setFullIssue((current) => mergeJiraIssueHydration(result, current, edited))
        if (!edited.has('title')) {
          setTitleDraft(result.title)
        }
        if (!edited.has('labels')) {
          setLabelsDraft(result.labels.join(', '))
        }
      })
      .catch(() => {})
      .finally(() => {
        if (fetchRequestId === issueRequestIdRef.current) {
          setIssueLoading(false)
        }
      })
  }, [issue, fetchKey, fetchSiteId, providerSettings, reloadSignal, hydrationScopeKey])

  // Reset per-scope mutation state when the scope moves to another issue/account/host/site.
  useEffect(() => {
    scopeGenerationRef.current += 1
    setPendingField(null)
    editedFieldsRef.current = new Set()
  }, [requestKey])

  // Why the cleanup: StrictMode double-mounts and a remount must re-run hydration,
  // not be mistaken for the same scope and skipped.
  useEffect(
    () => () => {
      issueRequestIdRef.current += 1
      loadedRequestKeyRef.current = null
    },
    []
  )

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
  const retryComments = commentsState.retryComments

  const onStatusSettled = useCallback(
    () => displayed && void reloadTransitions(),
    [displayed, reloadTransitions]
  )

  const onCommentsChanged = useCallback(
    () => displayed && void retryComments(),
    [displayed, retryComments]
  )

  useJiraIssueMutationState({
    scope: requestKey,
    issue,
    displayed,
    editedFieldsRef,
    setFullIssue,
    setTitleDraft,
    setLabelsDraft,
    onStatusSettled,
    onCommentsChanged
  })

  const { refreshIssue, refresh, refreshing } = useJiraIssueWorkspaceRefresh({
    displayed,
    providerSettings,
    sourceContext,
    reloadTransitions,
    refreshSignal,
    setFullIssue
  })

  const mutateIssue = useCallback(
    async (
      field: string,
      updates: Parameters<typeof jiraUpdateIssue>[2],
      optimistic?: Partial<JiraIssue>
    ): Promise<void> => {
      if (!displayed || !requestKey || pendingField) {
        return
      }
      const previous = displayed
      const sprintChanged = updates.sprintId !== undefined
      const previousSprintAssignment = sideData.sprintAssignment
      const scopeGeneration = scopeGenerationRef.current
      setPendingField(field)
      for (const editable of optimistic ? editedJiraIssueFields(optimistic) : []) {
        editedFieldsRef.current.add(editable)
      }
      try {
        await enqueueJiraIssueMutation({
          scope: requestKey,
          previous,
          optimistic: optimistic ?? {},
          commentsChanged: Boolean(updates.transitionComment?.trim()),
          update: async () => {
            if (sprintChanged) {
              selectSprint(updates.sprintId ?? null)
            }
            return jiraUpdateIssue(providerSettings, displayed.key, updates, siteId)
          },
          refresh: () => jiraGetIssue(providerSettings, displayed.key, displayed.siteId),
          patchIssue: (patch) =>
            patchJiraIssue(displayed.key, patch, {
              sourceContext,
              siteId: displayed.siteId,
              contextKey: mutationContextKey
            })
        })
        if (sprintChanged) {
          await reloadSprintAssignment()
        }
      } catch (error) {
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
        throw error
      } finally {
        if (scopeGeneration === scopeGenerationRef.current) {
          setPendingField(null)
        }
      }
    },
    [
      displayed,
      mutationContextKey,
      patchJiraIssue,
      pendingField,
      providerSettings,
      reloadSprintAssignment,
      requestKey,
      restoreSprintAssignment,
      selectSprint,
      sideData.sprintAssignment,
      siteId,
      sourceContext
    ]
  )

  const submitIssueFields = useCallback(
    (updates: Parameters<typeof jiraUpdateIssue>[2]) =>
      submitJiraIssueFields({
        displayed,
        pendingField,
        providerSettings,
        siteId,
        refreshIssue,
        reloadEditFields,
        setPendingField,
        updates
      }),
    [displayed, pendingField, providerSettings, siteId, refreshIssue, reloadEditFields]
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
    // Why the catch: a failed save is already surfaced by the toast; the draft
    // mutation promise must not reject unhandled.
    void mutateIssue('title', { title }, { title }).catch(() => {})
  }, [displayed, mutateIssue, titleDraft])

  const handleSaveLabels = useCallback(() => {
    if (!displayed) {
      return
    }
    const labels = labelsDraft
      .split(',')
      .map((label) => label.trim())
      .filter(Boolean)
    void mutateIssue('labels', { labels }, { labels }).catch(() => {})
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
