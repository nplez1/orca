import React, { useCallback, useState } from 'react'
import { Check, ChevronsDownUp, CornerDownLeft, ExternalLink, Reply, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import {
  RightPanelCommentComposer,
  type RightPanelCommentSubmitResult
} from '@/components/right-sidebar/right-panel-comment-composer'
import type { PRComment } from '../../../../shared/github/comment-types'
import { formatPrCommentRelativeTime } from '../../../../shared/pr-comment-time'
import { getDiffCommentLineLabel } from '@/lib/diff-comment-compat'
import { useCommentCardResize } from '../diff-comments/useCommentCardResize'
import type { DecoratedDiffComment } from '../diff-comments/decorated-diff-comment'
import { translate } from '@/i18n/i18n'

type Props = {
  comment: DecoratedDiffComment
  /** Absent when this thread cannot be replied to (no thread id, or a read-only surface). */
  onReply?: (body: string) => Promise<RightPanelCommentSubmitResult>
  /** Absent when this thread cannot be resolved from here (no thread id). */
  onSetResolved?: (resolve: boolean) => void | Promise<unknown>
  /** Collapses the thread back to its gutter marker. */
  onCollapse?: () => void
  onContentResize?: () => void
  observeRenderedSize?: boolean
}

function ThreadReplyRow({ reply, now }: { reply: PRComment; now: number }): React.JSX.Element {
  const relativeTime = formatPrCommentRelativeTime(reply.createdAt, now)
  return (
    <div className="orca-pr-comment-reply">
      {reply.authorAvatarUrl ? (
        <img className="orca-pr-comment-avatar" src={reply.authorAvatarUrl} alt={reply.author} />
      ) : (
        <span className="orca-pr-comment-avatar" aria-hidden />
      )}
      <div className="orca-pr-comment-reply-main">
        <div className="orca-pr-comment-reply-meta">
          <span className="orca-pr-comment-author">{reply.author}</span>
          {relativeTime ? <span className="orca-pr-comment-meta-text">{relativeTime}</span> : null}
        </div>
        <div className="orca-diff-comment-body">
          <CommentMarkdown content={reply.body} />
        </div>
      </div>
    </div>
  )
}

/**
 * A GitHub review thread drawn inline in the code.
 *
 * Deliberately a sibling of `DiffCommentCard`: same card surface, header row and pill actions, so a
 * reader moving between a local note and a review thread does not see a seam. What differs is the
 * thread work — replies, resolve, and the collapse that hands the thread back to its gutter marker.
 */
export function PRCommentThreadCard({
  comment,
  onReply,
  onSetResolved,
  onCollapse,
  onContentResize,
  observeRenderedSize
}: Props): React.JSX.Element {
  const thread = comment.thread
  // Why: the card is remounted into a view zone at an unpredictable moment, and relative labels
  // are presentation only — freezing "now" at mount keeps them from re-rendering mid-gesture.
  const [now] = useState(() => Date.now())
  const [repliesExpanded, setRepliesExpanded] = useState(false)
  const [replying, setReplying] = useState(false)
  const [resolving, setResolving] = useState(false)
  const replies = thread?.replies ?? []
  const isResolved = thread?.isResolved === true
  const canResolve = Boolean(thread?.threadId) && onSetResolved !== undefined
  const { cardRef, onContentResizeRef } = useCommentCardResize(
    observeRenderedSize === true,
    onContentResize
  )

  const handleResolveToggle = useCallback((): void => {
    if (!onSetResolved) {
      return
    }
    setResolving(true)
    void Promise.resolve(onSetResolved(!isResolved)).finally(() => setResolving(false))
  }, [isResolved, onSetResolved])

  const handleReply = useCallback(
    async (body: string): Promise<RightPanelCommentSubmitResult> => {
      if (!onReply) {
        return {
          ok: false,
          error: translate(
            'auto.components.pr.comment.inline.PRCommentThreadCard.3868fce1a3',
            'Replies are unavailable here.'
          )
        }
      }
      const result = await onReply(body)
      if (result.ok) {
        setReplying(false)
        onContentResizeRef.current?.()
      }
      return result
    },
    [onContentResizeRef, onReply]
  )

  const lineLabel = getDiffCommentLineLabel({
    lineNumber: comment.lineNumber,
    startLine: comment.startLine
  })

  return (
    <div ref={cardRef} className="orca-diff-comment-card orca-pr-comment-thread">
      <div className="orca-diff-comment-content-col">
        <div className="orca-diff-comment-header">
          <div className="orca-diff-comment-meta-group">
            {comment.authorAvatarUrl ? (
              <img
                className="orca-pr-comment-avatar"
                src={comment.authorAvatarUrl}
                alt={comment.author ?? ''}
              />
            ) : null}
            <span className="orca-pr-comment-author">{comment.author}</span>
            {comment.isBot ? (
              <span className="orca-pr-comment-bot-badge">
                {translate(
                  'auto.components.pr.comment.inline.PRCommentThreadCard.dfcd8f7f21',
                  'bot'
                )}
              </span>
            ) : null}
            <span className="orca-pr-comment-meta-text">{lineLabel}</span>
            {comment.createdAtLabel ? (
              <span className="orca-pr-comment-meta-text">{comment.createdAtLabel}</span>
            ) : null}
            {isResolved ? (
              <span className="orca-pr-comment-resolved-badge">
                <Check className="size-3" />
                {translate(
                  'auto.components.pr.comment.inline.PRCommentThreadCard.27eb8f6ea9',
                  'Resolved'
                )}
              </span>
            ) : null}
          </div>

          <div
            className="orca-diff-comment-actions-pill"
            onMouseDown={(event) => event.stopPropagation()}
          >
            {onReply ? (
              <button
                type="button"
                className="orca-diff-comment-pill-btn"
                aria-label={translate(
                  'auto.components.pr.comment.inline.PRCommentThreadCard.be8d2e8f48',
                  'Reply'
                )}
                title={translate(
                  'auto.components.pr.comment.inline.PRCommentThreadCard.be8d2e8f48',
                  'Reply'
                )}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  setReplying((prev) => !prev)
                }}
              >
                <Reply className="size-3" />
              </button>
            ) : null}
            {canResolve ? (
              <button
                type="button"
                className={cn('orca-diff-comment-pill-btn', resolving && 'pointer-events-none')}
                aria-label={
                  isResolved
                    ? translate(
                        'auto.components.pr.comment.inline.PRCommentThreadCard.b50141162f',
                        'Unresolve thread'
                      )
                    : translate(
                        'auto.components.pr.comment.inline.PRCommentThreadCard.3b01798961',
                        'Resolve thread'
                      )
                }
                title={
                  isResolved
                    ? translate(
                        'auto.components.pr.comment.inline.PRCommentThreadCard.b50141162f',
                        'Unresolve thread'
                      )
                    : translate(
                        'auto.components.pr.comment.inline.PRCommentThreadCard.3b01798961',
                        'Resolve thread'
                      )
                }
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  handleResolveToggle()
                }}
              >
                {isResolved ? <Undo2 className="size-3" /> : <Check className="size-3" />}
              </button>
            ) : null}
            {comment.url ? (
              <button
                type="button"
                className="orca-diff-comment-pill-btn"
                aria-label={translate(
                  'auto.components.pr.comment.inline.PRCommentThreadCard.e2be68390f',
                  'Open on GitHub'
                )}
                title={translate(
                  'auto.components.pr.comment.inline.PRCommentThreadCard.e2be68390f',
                  'Open on GitHub'
                )}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  void window.api.shell.openUrl(comment.url ?? '')
                }}
              >
                <ExternalLink className="size-3" />
              </button>
            ) : null}
            {onCollapse ? (
              <button
                type="button"
                className="orca-diff-comment-pill-btn"
                aria-label={translate(
                  'auto.components.pr.comment.inline.PRCommentThreadCard.2002706ed8',
                  'Hide thread'
                )}
                title={translate(
                  'auto.components.pr.comment.inline.PRCommentThreadCard.2002706ed8',
                  'Hide thread'
                )}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  onCollapse()
                }}
              >
                <ChevronsDownUp className="size-3" />
              </button>
            ) : null}
          </div>
        </div>

        <div className="orca-diff-comment-body">
          <CommentMarkdown content={comment.body} />
        </div>

        {replies.length > 0 ? (
          <div className="orca-pr-comment-replies">
            <button
              type="button"
              className="orca-pr-comment-replies-toggle"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setRepliesExpanded((prev) => !prev)
                onContentResizeRef.current?.()
              }}
            >
              {repliesExpanded
                ? translate(
                    'auto.components.pr.comment.inline.PRCommentThreadCard.b1daf89414',
                    'Hide {{value0}} {{value1}}',
                    { value0: replies.length, value1: replies.length === 1 ? 'reply' : 'replies' }
                  )
                : translate(
                    'auto.components.pr.comment.inline.PRCommentThreadCard.21e296c94d',
                    'Show {{value0}} {{value1}}',
                    { value0: replies.length, value1: replies.length === 1 ? 'reply' : 'replies' }
                  )}
            </button>
            {repliesExpanded
              ? replies.map((reply) => <ThreadReplyRow key={reply.id} reply={reply} now={now} />)
              : null}
          </div>
        ) : null}

        {replying && onReply ? (
          <div className="orca-pr-comment-composer">
            <RightPanelCommentComposer
              placeholder={translate(
                'auto.components.pr.comment.inline.PRCommentThreadCard.90e6e6fd21',
                'Reply to this thread'
              )}
              submitLabel="Reply"
              autoFocus
              onCancel={() => {
                setReplying(false)
                onContentResizeRef.current?.()
              }}
              onSubmit={handleReply}
            />
          </div>
        ) : null}

        {!replying && onReply ? (
          <button
            type="button"
            className="orca-pr-comment-reply-trigger"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setReplying(true)
              onContentResizeRef.current?.()
            }}
          >
            <CornerDownLeft className="size-3" />
            {translate('auto.components.pr.comment.inline.PRCommentThreadCard.be8d2e8f48', 'Reply')}
          </button>
        ) : null}
      </div>
    </div>
  )
}
