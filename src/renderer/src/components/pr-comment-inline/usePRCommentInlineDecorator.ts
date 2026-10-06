import { useCallback, useEffect, useMemo } from 'react'
import type { editor as monacoEditor } from 'monaco-editor'
import { useAppStore } from '@/store'
import { resolvePRCommentInlineDisplay } from '@/lib/pr-comment-inline-display'
import { getCommentBodyLayoutLineCount } from '@/lib/comment-body-line-count'
import type { DecoratedDiffComment } from '../diff-comments/decorated-diff-comment'
import { useDiffCommentDecorator } from '../diff-comments/useDiffCommentDecorator'
import { ZONE_CHROME_PX, ZONE_LINE_PX } from '../diff-comments/diff-comment-view-zone-entry'
import type { RightPanelCommentSubmitResult } from '../right-sidebar/right-panel-comment-composer'
import { toInlinePRComments } from './pr-comment-inline-comments'
import type { PRCommentInlineThread } from './pr-comment-inline-threads'
import { usePRCommentGutterMarks, type PRCommentGutterMark } from './usePRCommentGutterMarks'
import { translate } from '@/i18n/i18n'

// Why: a review thread renders replies and a reply trigger that a local note does not. Only an
// estimate — the card's resize observer reports the real height — but Monaco bleeds an
// underestimate into the lines below it until then.
const THREAD_TRIGGER_PX = 28

/** A no-op, stable identity so the decorator's required delete handler does not churn the zones. */
const ignoreCommentDelete = (): void => {}

type PRCommentInlineDecoratorArgs = {
  editor: monacoEditor.ICodeEditor | null
  monacoModelIdentity?: string
  /** The editor's own spelling of the file path; review comments adopt it. */
  filePath: string
  /** Review threads for this file, or null when the file belongs to no reviewable pull request. */
  threads: readonly PRCommentInlineThread[] | null
  /** Namespaces these threads away from the worktree's local notes. */
  scope: string | null
  /** The global "PR Comments Inline" setting: expands threads by default when on. */
  enabled: boolean
  onReply?: (thread: PRCommentInlineThread, body: string) => Promise<RightPanelCommentSubmitResult>
  onResolveThread?: (threadId: string, resolve: boolean) => void | Promise<unknown>
  /** Inline comment id a surface asked to reveal; expanded first if it is collapsed. */
  pendingRevealCommentId?: string | null
  onPendingRevealConsumed?: () => void
}

/**
 * Renders GitHub review threads on their commented lines, and a gutter bubble where one is hidden.
 *
 * This is a thin layer over the shared inline-comment zone decorator: it decides *which* threads are
 * drawn open, draws the rest as gutter markers, and hands the open ones over. Keeping the zone
 * lifecycle in one place is what lets a review thread and a local note share a surface.
 */
export function usePRCommentInlineDecorator({
  editor,
  monacoModelIdentity,
  filePath,
  threads,
  scope,
  enabled,
  onReply,
  onResolveThread,
  pendingRevealCommentId,
  onPendingRevealConsumed
}: PRCommentInlineDecoratorArgs): void {
  const displayOverrides = useAppStore((s) => s.prCommentInlineDisplayById)
  const setPRCommentInlineDisplay = useAppStore((s) => s.setPRCommentInlineDisplay)

  const displayOf = useCallback(
    (thread: PRCommentInlineThread) =>
      resolvePRCommentInlineDisplay({
        override: displayOverrides[thread.id],
        enabled,
        isResolved: thread.isResolved
      }),
    [displayOverrides, enabled]
  )

  // Why: reading a collapsed thread from the Checks pane must land on the comment, not on a marker.
  // Expanding here and letting the decorator's own reveal run on the next pass keeps one reveal path.
  useEffect(() => {
    if (!pendingRevealCommentId || !threads) {
      return
    }
    const target = threads.find((thread) => thread.id === pendingRevealCommentId)
    if (target && displayOf(target) !== 'expanded') {
      setPRCommentInlineDisplay(target.id, 'expanded')
    }
  }, [displayOf, pendingRevealCommentId, setPRCommentInlineDisplay, threads])

  const expandedThreads = useMemo(
    () => (threads ?? []).filter((thread) => displayOf(thread) === 'expanded'),
    [displayOf, threads]
  )
  const gutterMarks = useMemo<PRCommentGutterMark[]>(
    () =>
      (threads ?? [])
        .filter((thread) => displayOf(thread) !== 'expanded')
        .map((thread) => ({ id: thread.id, line: thread.line })),
    [displayOf, threads]
  )

  usePRCommentGutterMarks({
    editor,
    monacoModelIdentity,
    marks: gutterMarks,
    onActivate: (commentId) => setPRCommentInlineDisplay(commentId, 'expanded')
  })

  const inlineComments = useMemo<DecoratedDiffComment[]>(
    () => (scope ? toInlinePRComments({ threads: expandedThreads, scope, filePath }) : []),
    [expandedThreads, filePath, scope]
  )

  const handleReplyToThread = useCallback(
    (comment: DecoratedDiffComment, body: string): Promise<RightPanelCommentSubmitResult> => {
      const thread = expandedThreads.find((candidate) => candidate.id === comment.id)
      if (!thread || !onReply) {
        return Promise.resolve({
          ok: false,
          error: translate(
            'auto.components.pr.comment.inline.usePRCommentInlineDecorator.c3b537227a',
            'Replies are unavailable here.'
          )
        })
      }
      return onReply(thread, body)
    },
    [expandedThreads, onReply]
  )

  const estimateZoneHeight = useCallback((comment: DecoratedDiffComment): number => {
    const rootLines = getCommentBodyLayoutLineCount(comment.body)
    const replyLines = (comment.thread?.replies ?? []).reduce(
      (total, reply) => total + getCommentBodyLayoutLineCount(reply.body),
      0
    )
    return ZONE_CHROME_PX + THREAD_TRIGGER_PX + (rootLines + replyLines) * ZONE_LINE_PX
  }, [])

  useDiffCommentDecorator({
    editor,
    monacoModelIdentity,
    filePath,
    worktreeId: scope ?? '',
    comments: inlineComments,
    // Why: this surface only draws review threads; an empty list suppresses the add-note overlay
    // that `null` would read as "every line is commentable".
    commentableLineNumbers: NO_COMMENTABLE_LINES,
    onDeleteComment: ignoreCommentDelete,
    onReplyToThread: onReply ? handleReplyToThread : undefined,
    onSetThreadResolved: onResolveThread,
    onCollapseThread: (commentId) => setPRCommentInlineDisplay(commentId, 'collapsed'),
    estimateZoneHeight,
    pendingScrollCommentId: pendingRevealCommentId ?? null,
    onPendingScrollConsumed: onPendingRevealConsumed
  })
}

const NO_COMMENTABLE_LINES: readonly number[] = []
