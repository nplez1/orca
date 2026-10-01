/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: Jira issue hydration, comments, transitions, priorities, and user options are loaded from provider IPC for the selected issue. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { jiraGetIssue, jiraUpdateIssue } from '@/runtime/runtime-jira-client'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-target'
import type {
  JiraComment,
  JiraIssue,
  JiraPriority,
  JiraTransition,
  JiraUser
} from '../../../shared/jira-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'
import { useJiraIssueComments } from './jira-issue-workspace-comments'
import { useJiraIssueSideData } from './jira-issue-workspace-side-data'

export type JiraIssueWorkspaceDetailState = {
  displayed: JiraIssue | null
  issueLoading: boolean
  comments: JiraComment[]
  commentsLoading: boolean
  commentsError: string | null
  transitions: JiraTransition[]
  priorities: JiraPriority[]
  users: JiraUser[]
  pendingField: string | null
  titleDraft: string
  setTitleDraft: (value: string) => void
  labelsDraft: string
  setLabelsDraft: (value: string) => void
  commentDraft: string
  setCommentDraft: (value: string) => void
  commentSubmitting: boolean
  canSubmitComment: boolean
  handleSaveTitle: () => void
  handleSaveLabels: () => void
  handleSubmitComment: () => Promise<void>
  retryComments: () => void
  refreshing: boolean
  refresh: () => Promise<void>
  /** Re-runs the initial issue fetch; used before anything is displayed. */
  reload: () => void
  mutateIssue: (
    field: string,
    updates: Parameters<typeof jiraUpdateIssue>[2],
    optimistic?: Partial<JiraIssue>
  ) => Promise<void>
}

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
  providerSettings,
  sourceContext,
  refreshSignal = 0
}: {
  issue: JiraIssue | null
  fetchKey?: string | null
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

  useEffect(() => {
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

    const fetchRequestId = ++issueRequestIdRef.current
    void jiraGetIssue(providerSettings, seed?.key ?? fetchKey!, seed?.siteId)
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
  }, [issue, fetchKey, providerSettings, reloadSignal])

  const sideData = useJiraIssueSideData({ providerSettings, issueKey, issueSiteId: siteId })
  const commentsState = useJiraIssueComments({ providerSettings, issueKey, issueSiteId: siteId })
  const reloadTransitions = sideData.reloadTransitions

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
      try {
        if (optimistic) {
          setFullIssue({ ...displayed, ...optimistic })
          patchJiraIssue(displayed.key, optimistic, { sourceContext })
        }
        const result = await jiraUpdateIssue(providerSettings, displayed.key, updates, siteId)
        if (!result.ok) {
          throw new Error(result.error)
        }
        await refreshIssue()
      } catch (error) {
        setFullIssue(previous)
        patchJiraIssue(previous.key, previous, { sourceContext })
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
    [displayed, patchJiraIssue, pendingField, refreshIssue, providerSettings, siteId, sourceContext]
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
    mutateIssue
  }
}
