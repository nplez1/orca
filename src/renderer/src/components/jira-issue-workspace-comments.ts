import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  getCommentBodySubmitState,
  hasBoundedCommentBodyText
} from '@/lib/comment-body-submit-state'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { jiraAddIssueComment, jiraIssueComments } from '@/runtime/runtime-jira-client'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-target'
import type { JiraComment } from '../../../shared/jira-types'
import { translate } from '@/i18n/i18n'

export type JiraIssueCommentsState = {
  comments: JiraComment[]
  commentsLoading: boolean
  commentsError: string | null
  commentDraft: string
  setCommentDraft: (value: string) => void
  commentSubmitting: boolean
  canSubmitComment: boolean
  handleSubmitComment: () => Promise<void>
  retryComments: () => void
}

/** Loads and posts comments for one Jira issue. Split out of
 *  `useJiraIssueWorkspaceDetail` so each hook stays within the file line cap. */
export function useJiraIssueComments({
  providerSettings,
  issueKey,
  issueSiteId
}: {
  providerSettings: RuntimeJiraSettings
  issueKey: string | null
  issueSiteId: string | undefined
}): JiraIssueCommentsState {
  const [comments, setComments] = useState<JiraComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentsError, setCommentsError] = useState<string | null>(null)
  const [commentDraft, setCommentDraft] = useState('')
  const [commentSubmitting, setCommentSubmitting] = useState(false)
  const requestIdRef = useRef(0)
  const optimisticCommentsRef = useRef<JiraComment[]>([])

  const loadComments = useCallback(
    async (key: string, siteId: string | undefined, requestId: number): Promise<void> => {
      setCommentsLoading(true)
      setCommentsError(null)
      try {
        let fetched = await jiraIssueComments(providerSettings, key, siteId)
        if (requestId !== requestIdRef.current) {
          return
        }
        const optimistic = optimisticCommentsRef.current
        if (optimistic.length > 0) {
          const fetchedIds = new Set(fetched.map((comment) => comment.id))
          fetched = [...fetched, ...optimistic.filter((comment) => !fetchedIds.has(comment.id))]
        }
        setComments(fetched)
      } catch (error) {
        if (requestId === requestIdRef.current) {
          setCommentsError(error instanceof Error ? error.message : 'Failed to load comments.')
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setCommentsLoading(false)
        }
      }
    },
    [providerSettings]
  )

  useEffect(() => {
    optimisticCommentsRef.current = []
    setComments([])
    setCommentsError(null)
    setCommentDraft('')
    if (!issueKey) {
      setCommentsLoading(false)
      return
    }
    void loadComments(issueKey, issueSiteId, ++requestIdRef.current)
  }, [issueKey, issueSiteId, loadComments])

  const handleSubmitComment = useCallback(async (): Promise<void> => {
    if (!issueKey || commentSubmitting) {
      return
    }
    const bodyState = getCommentBodySubmitState(commentDraft)
    if (bodyState.status === 'empty') {
      return
    }
    if (bodyState.status === 'too-large-leading-whitespace') {
      toast.error(
        translate(
          'auto.components.JiraIssueWorkspace.commentTooLarge',
          'Comment is too large to submit safely.'
        )
      )
      return
    }
    setCommentSubmitting(true)
    try {
      const result = await jiraAddIssueComment(
        providerSettings,
        issueKey,
        bodyState.body,
        issueSiteId
      )
      if (!result.ok) {
        throw new Error(result.error)
      }
      const comment: JiraComment = {
        id: result.id || createBrowserUuid(),
        body: bodyState.body,
        createdAt: new Date().toISOString(),
        user: { accountId: 'local', displayName: 'You' }
      }
      optimisticCommentsRef.current.push(comment)
      setComments((prev) => [...prev, comment])
      setCommentDraft('')
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate('auto.components.JiraIssueWorkspace.fa132c8aed', 'Failed to add comment.')
      )
    } finally {
      setCommentSubmitting(false)
    }
  }, [commentDraft, commentSubmitting, issueKey, issueSiteId, providerSettings])

  const retryComments = useCallback((): void => {
    if (issueKey) {
      void loadComments(issueKey, issueSiteId, ++requestIdRef.current)
    }
  }, [issueKey, issueSiteId, loadComments])

  return {
    comments,
    commentsLoading,
    commentsError,
    commentDraft,
    setCommentDraft,
    commentSubmitting,
    canSubmitComment: hasBoundedCommentBodyText(commentDraft),
    handleSubmitComment,
    retryComments
  }
}
