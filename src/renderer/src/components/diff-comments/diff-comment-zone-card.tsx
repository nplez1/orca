import type { GitHubImageIntake } from '@/components/github/use-github-image-uploads'
import type { DiffCommentOwner } from '@/store/slices/diff-comments/diff-comment-owner'
import type { RefObject } from 'react'
import type { Root } from 'react-dom/client'
import { formatDiffComments } from '../../../../shared/diff-comments-format'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PRCommentThreadCard } from '../pr-comment-inline/PRCommentThreadCard'
import type { RightPanelCommentSubmitResult } from '../right-sidebar/checks-panel/comments/right-panel-comment-composer'
import type { DiffCommentDeliverySnapshot } from '@/store/slices/diff-comments/create-diff-comments-slice'
import { DiffCommentCard } from './DiffCommentCard'
import { DiffCommentDraftCard } from './DiffCommentDraftCard'
import type { DecoratedDiffComment } from './decorated-diff-comment'
import {
  NotesSendMenu,
  type NotesSendMenuScope
} from '../editor/review-note-delivery/NotesSendMenu'
import { translate } from '@/i18n/i18n'
import { TranslationScopeProvider } from '@/i18n/translation-scope-provider'

export function getRenderSignature(
  comment: DecoratedDiffComment,
  formatCommentPrompt?: (comment: DecoratedDiffComment) => string
): string {
  return JSON.stringify({
    body: comment.body,
    sentAt: comment.sentAt ?? null,
    author: comment.author ?? null,
    authorAvatarUrl: comment.authorAvatarUrl ?? null,
    createdAtLabel: comment.createdAtLabel ?? null,
    url: comment.url ?? null,
    canDelete: comment.canDelete ?? null,
    canEdit: comment.canEdit ?? null,
    // Why: reply and resolve mutate the thread in place. Without these, an optimistic cache write
    // would leave the already-mounted zone showing the thread as it was when it was inserted.
    isBot: comment.isBot ?? null,
    thread: comment.thread
      ? {
          threadId: comment.thread.threadId ?? null,
          isResolved: comment.thread.isResolved,
          replies: comment.thread.replies.map((reply) => ({
            id: reply.id,
            body: reply.body,
            author: reply.author,
            createdAt: reply.createdAt
          }))
        }
      : null,
    sendPrompt: formatCommentPrompt ? formatCommentPrompt(comment) : null
  })
}

function getSingleCommentSendScopes(
  comment: DecoratedDiffComment,
  formatCommentPrompt?: (comment: DecoratedDiffComment) => string
): NotesSendMenuScope<DecoratedDiffComment>[] {
  return [
    {
      id: 'note',
      label: translate(
        'auto.components.diff.comments.useDiffCommentDecorator.995fa28b50',
        'This note'
      ),
      notes: comment.sentAt ? [] : [comment],
      formatPrompt: () =>
        formatCommentPrompt ? formatCommentPrompt(comment) : formatDiffComments([comment])
    }
  ]
}

// Callbacks arrive as refs so the rendered props keep the decorator's identity semantics.
export type DiffCommentZoneCardContext = {
  owner: DiffCommentOwner | null
  worktreeId: string
  filePath: string
  activeGroupId: string
  formatCommentPrompt?: (comment: DecoratedDiffComment) => string
  resizeZone: (commentId: string) => void
  onDeleteCommentRef: RefObject<(commentId: string) => void>
  onUpdateCommentRef: RefObject<((commentId: string, body: string) => Promise<boolean>) | undefined>
  /** Reply to a review thread's root comment. Absent on surfaces that cannot post. */
  onReplyToThreadRef?: RefObject<
    | ((comment: DecoratedDiffComment, body: string) => Promise<RightPanelCommentSubmitResult>)
    | undefined
  >
  /** Resolve or unresolve a review thread. Absent on surfaces that cannot mutate the thread. */
  onSetThreadResolvedRef?: RefObject<
    ((threadId: string, resolve: boolean) => void | Promise<unknown>) | undefined
  >
  /** Collapses an expanded thread back to its gutter marker. Absent where nothing draws markers. */
  onCollapseThreadRef?: RefObject<((commentId: string) => void) | undefined>
  clearDeliveredDiffComments: (
    owner: DiffCommentOwner,
    comments: readonly DiffCommentDeliverySnapshot[]
  ) => Promise<boolean>
}

function renderPRCommentThreadCard(
  root: Root,
  comment: DecoratedDiffComment,
  context: DiffCommentZoneCardContext
): void {
  const onReplyToThread = context.onReplyToThreadRef?.current
  const onSetThreadResolved = context.onSetThreadResolvedRef?.current
  const onCollapseThread = context.onCollapseThreadRef?.current
  root.render(
    // View zones are separate React roots outside the app root, so App.tsx context providers don't reach them.
    <TooltipProvider delayDuration={400}>
      <PRCommentThreadCard
        comment={comment}
        onReply={onReplyToThread ? (body) => onReplyToThread(comment, body) : undefined}
        onSetResolved={
          onSetThreadResolved && comment.thread?.threadId
            ? (resolve) => onSetThreadResolved(comment.thread?.threadId ?? '', resolve)
            : undefined
        }
        onCollapse={onCollapseThread ? () => onCollapseThread(comment.id) : undefined}
        onContentResize={() => context.resizeZone(comment.id)}
        observeRenderedSize
      />
    </TooltipProvider>
  )
}

export function renderDiffCommentZoneCard(
  root: Root,
  comment: DecoratedDiffComment,
  context: DiffCommentZoneCardContext
): void {
  const {
    owner,
    worktreeId,
    filePath,
    activeGroupId,
    formatCommentPrompt,
    resizeZone,
    onDeleteCommentRef,
    onUpdateCommentRef,
    clearDeliveredDiffComments
  } = context
  if (comment.thread) {
    renderPRCommentThreadCard(root, comment, context)
    return
  }
  root.render(
    // View zones are separate React roots outside the app root, so App.tsx context providers don't reach them.
    <TranslationScopeProvider>
      <TooltipProvider>
        <DiffCommentCard
          lineNumber={comment.lineNumber}
          startLine={comment.startLine}
          body={comment.body}
          sentAt={comment.sentAt}
          author={comment.author}
          createdAtLabel={comment.createdAtLabel}
          url={comment.url}
          onDelete={
            comment.canDelete === false ? undefined : () => onDeleteCommentRef.current(comment.id)
          }
          onSubmitEdit={
            onUpdateCommentRef.current && comment.canEdit !== false
              ? async (body) => {
                  const fn = onUpdateCommentRef.current
                  if (!fn) {
                    return false
                  }
                  return fn(comment.id, body)
                }
              : undefined
          }
          onContentResize={() => resizeZone(comment.id)}
          observeRenderedSize
          headerActions={
            worktreeId && comment.author === undefined ? (
              <NotesSendMenu
                owner={owner}
                worktreeId={worktreeId}
                groupId={activeGroupId}
                modeIdParts={['diff-comment-note', worktreeId, filePath, comment.id]}
                scopes={getSingleCommentSendScopes(comment, formatCommentPrompt)}
                targetModeLabel={translate(
                  'auto.components.diff.comments.useDiffCommentDecorator.995fa28b50',
                  'This note'
                )}
                triggerClassName="orca-diff-comment-edit"
                disabledTooltip={translate(
                  'auto.components.diff.comments.diffCommentZoneCard.noteAlreadySent',
                  'Note already sent'
                )}
                onDelivered={(notes) => void (owner && clearDeliveredDiffComments(owner, notes))}
              />
            ) : null
          }
        />
      </TooltipProvider>
    </TranslationScopeProvider>
  )
}

export type DiffCommentDraftCardContext = {
  imageUploadAddress?: GitHubImageIntake['address']
  placeholder?: string
  submitLabel?: string
  submittingLabel?: string
  initialBody?: string
  onBodyChange?: (body: string) => void
  resizeZone: () => void
  onCancel: () => void
  onSubmit: (body: string) => Promise<boolean>
}

export function renderDiffCommentDraftCard(
  root: Root,
  draft: { lineNumber: number; startLine?: number },
  {
    imageUploadAddress,
    placeholder,
    submitLabel,
    submittingLabel,
    initialBody,
    onBodyChange,
    resizeZone,
    onCancel,
    onSubmit
  }: DiffCommentDraftCardContext
): void {
  root.render(
    <TranslationScopeProvider>
      <TooltipProvider>
        <DiffCommentDraftCard
          imageUploadAddress={imageUploadAddress}
          lineNumber={draft.lineNumber}
          startLine={draft.startLine}
          placeholder={placeholder}
          submitLabel={submitLabel}
          submittingLabel={submittingLabel}
          initialBody={initialBody}
          onBodyChange={onBodyChange}
          onCancel={onCancel}
          onSubmit={onSubmit}
          onContentResize={resizeZone}
        />
      </TooltipProvider>
    </TranslationScopeProvider>
  )
}
