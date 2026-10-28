import { useCallback } from 'react'
import { toast } from 'sonner'
import { mergePRCommentIntoList } from '@/store/github/pr-comment-cache'
import {
  acknowledgePRCommentsAfterAiLaunch,
  attachPRReviewReplyParent,
  canPostPRReviewThreadReply,
  checksPanelReviewStableKey,
  hasPRCommentGroupNeedingReply,
  resolvePRReviewReplyThreadId,
  setPendingPRCommentAiAck,
  takePendingPRCommentAiAck
} from '../pr-comments-ai-launch-ack'
import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import type { ChecksPanelReviewDataState } from './use-checks-panel-review-data'
import { clearPRCommentsListSelection } from '../pr-comments-list-selection'
import { translate } from '@/i18n/i18n'
import type { ChecksAgentComposerState } from './panel-state-types'

type ChecksPanelAiAcknowledgementInput = Pick<
  ChecksPanelControllerState,
  | 'addPRConversationComment'
  | 'addPRReviewCommentReply'
  | 'asyncResultKeyRef'
  | 'claimedCommentResolutionRef'
  | 'commentsRef'
  | 'commentsSelectionClearTokenRef'
  | 'pendingCommentResolutionRef'
  | 'setCommentResolutionAckBusyNow'
  | 'setComments'
  | 'setCommentsSelectionClearRequest'
  | 'commentResolutionLaunchAcceptedRef'
> &
  Pick<ChecksPanelReviewDataState, 'fetchComments'>

export function useChecksPanelAiAcknowledgement(model: ChecksPanelAiAcknowledgementInput) {
  const {
    addPRConversationComment,
    addPRReviewCommentReply,
    asyncResultKeyRef,
    claimedCommentResolutionRef,
    commentsRef,
    commentsSelectionClearTokenRef,
    fetchComments,
    pendingCommentResolutionRef,
    setCommentResolutionAckBusyNow,
    setComments,
    setCommentsSelectionClearRequest,
    commentResolutionLaunchAcceptedRef
  } = model
  const clearSentCommentSelection = useCallback(
    (reviewContextKey: string): void => {
      clearPRCommentsListSelection(reviewContextKey)
      commentsSelectionClearTokenRef.current += 1
      setCommentsSelectionClearRequest({
        contextKey: reviewContextKey,
        token: commentsSelectionClearTokenRef.current
      })
    },
    [commentsSelectionClearTokenRef, setCommentsSelectionClearRequest]
  )

  const refreshCommentsAfterReplies = useCallback(async (): Promise<void> => {
    await fetchComments({ force: true })
  }, [fetchComments])

  const replyToSelectedCommentsAfterLaunch = useCallback(
    async (resolution: NonNullable<ChecksAgentComposerState['commentResolution']>) => {
      clearSentCommentSelection(resolution.reviewContextKey)
      // Why: ignore headSha churn; only abort the UI refresh if the user left this PR/panel.
      const launchStableKey = checksPanelReviewStableKey(resolution.reviewContextKey)
      // Host calls keep the snapshotted target; gate UI writes so replies cannot appear in another review.
      const isPanelStillOnLaunchReview = (): boolean =>
        checksPanelReviewStableKey(asyncResultKeyRef.current) === launchStableKey
      const githubTarget = resolution.githubTarget
      // Why: GitHub is the only provider Orca replies on today; MR threads and GitHub threads
      // the host can resolve are left open for the user, with no host write at all.
      const canReplyOnHost = resolution.provider === 'github' && githubTarget != null
      // Why: a PR with no reply target cannot be answered; only report it when something in the
      // selection would otherwise have been replied to.
      let lastHostError =
        resolution.provider === 'github' &&
        githubTarget == null &&
        hasPRCommentGroupNeedingReply(resolution.selectedGroups)
          ? translate(
              'auto.components.right.sidebar.ChecksPanel.7e4b2a19c0',
              'Could not identify the GitHub PR to reply on.'
            )
          : undefined
      const counts = await acknowledgePRCommentsAfterAiLaunch({
        groups: resolution.selectedGroups,
        deps: {
          canReply: canReplyOnHost,
          replyInThread: async (comment, body) => {
            if (!githubTarget || !canPostPRReviewThreadReply(comment)) {
              return false
            }
            try {
              const parentThreadId =
                resolvePRReviewReplyThreadId({
                  parent: comment,
                  existingComments: commentsRef.current
                }) ?? comment.threadId
              const result = await addPRReviewCommentReply(
                githubTarget.repoPath,
                githubTarget.prNumber,
                comment.id,
                body,
                {
                  repoId: githubTarget.repoId,
                  prRepo: githubTarget.prRepo,
                  threadId: parentThreadId,
                  path: comment.path,
                  line: comment.line
                }
              )
              if (result.ok) {
                // Attach threadId/path because API omissions would otherwise leave optimistic replies outside their parent.
                if (isPanelStillOnLaunchReview()) {
                  setComments((prev) =>
                    mergePRCommentIntoList(
                      prev,
                      attachPRReviewReplyParent(result.comment, {
                        ...comment,
                        threadId: parentThreadId
                      })
                    )
                  )
                }
                return true
              }
              lastHostError = result.error
              console.warn('In-thread fixing reply failed:', result.error)
              return false
            } catch (err) {
              lastHostError = err instanceof Error ? err.message : String(err)
              console.warn('Failed to post in-thread fixing reply for review comment:', err)
              return false
            }
          },
          // Conversation/review-summary comments lack nested replies; combine their acknowledgements into one body.
          replyAsConversation: async (body) => {
            if (!githubTarget) {
              return false
            }
            try {
              const result = await addPRConversationComment(
                githubTarget.repoPath,
                githubTarget.prNumber,
                body,
                {
                  repoId: githubTarget.repoId,
                  prRepo: githubTarget.prRepo
                }
              )
              if (result.ok) {
                if (isPanelStillOnLaunchReview()) {
                  setComments((prev) => mergePRCommentIntoList(prev, result.comment))
                }
                return true
              }
              lastHostError = result.error
              console.warn('Conversation fixing reply failed:', result.error)
              return false
            } catch (err) {
              lastHostError = err instanceof Error ? err.message : String(err)
              console.warn('Failed to post conversation fixing reply for review comment:', err)
              return false
            }
          }
        }
      })

      if (canReplyOnHost && isPanelStillOnLaunchReview()) {
        await refreshCommentsAfterReplies()
      }

      // Why: surface the underlying API error when replies were possible but none landed.
      // Threads that need no reply are left open by design, so replied=0 is not a failure there.
      const repliedNoneDespiteHostSupport =
        canReplyOnHost &&
        counts.replied === 0 &&
        hasPRCommentGroupNeedingReply(resolution.selectedGroups)
      if (counts.failed > 0 || repliedNoneDespiteHostSupport || lastHostError) {
        toast.error(
          translate(
            'auto.components.right.sidebar.ChecksPanel.f273f2271c',
            'Started the agent. Replied to {{value0}}, left {{value1}} open, failed {{value2}}.{{value3}}',
            {
              value0: counts.replied,
              value1: counts.leftOpen,
              value2: counts.failed,
              value3: lastHostError ? ` ${lastHostError}` : ''
            }
          )
        )
        return
      }
      toast.success(
        translate(
          'auto.components.right.sidebar.ChecksPanel.aa95b81a3a',
          'Started the agent. Replied to {{value0}}, left {{value1}} open, failed {{value2}}.',
          {
            value0: counts.replied,
            value1: counts.leftOpen,
            value2: counts.failed
          }
        )
      )
    },
    [
      addPRConversationComment,
      addPRReviewCommentReply,
      clearSentCommentSelection,
      refreshCommentsAfterReplies,
      commentsRef,
      setComments,
      asyncResultKeyRef
    ]
  )

  // Claim on accept, hand back on abort, reply only after delivery — fixing replies are irreversible.
  const commentLaunchCallbacks = (
    resolution: NonNullable<ChecksAgentComposerState['commentResolution']>
  ) => {
    let delivered = false
    return {
      onLaunchAccepted: () => {
        takePendingPRCommentAiAck(resolution)
        if (pendingCommentResolutionRef.current === resolution) {
          pendingCommentResolutionRef.current = null
        }
        claimedCommentResolutionRef.current = resolution
        commentResolutionLaunchAcceptedRef.current = true
        setCommentResolutionAckBusyNow(true)
      },
      onLaunchAborted: () => {
        if (claimedCommentResolutionRef.current === resolution) {
          claimedCommentResolutionRef.current = null
        }
        commentResolutionLaunchAcceptedRef.current = false
        pendingCommentResolutionRef.current = resolution
        setPendingPRCommentAiAck(resolution)
        setCommentResolutionAckBusyNow(false)
      },
      onLaunched: () => {
        if (delivered) {
          return
        }
        delivered = true
        takePendingPRCommentAiAck(resolution)
        if (pendingCommentResolutionRef.current === resolution) {
          pendingCommentResolutionRef.current = null
        }
        if (claimedCommentResolutionRef.current === resolution) {
          claimedCommentResolutionRef.current = null
        }
        commentResolutionLaunchAcceptedRef.current = false
        setCommentResolutionAckBusyNow(true)
        void replyToSelectedCommentsAfterLaunch(resolution)
          .catch((err) => {
            console.warn('Failed to reply on selected review comments after AI launch:', err)
            toast.error(
              translate(
                'auto.components.right.sidebar.ChecksPanel.495b2f8c4b',
                'Started the agent, but could not reply on the selected comments.'
              )
            )
          })
          .finally(() => setCommentResolutionAckBusyNow(false))
      }
    }
  }
  return {
    clearSentCommentSelection,
    refreshCommentsAfterReplies,
    replyToSelectedCommentsAfterLaunch,
    commentLaunchCallbacks
  }
}

export type ChecksPanelAiAcknowledgementState = ReturnType<typeof useChecksPanelAiAcknowledgement>
