import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import type { RightPanelCommentSubmitResult } from '../right-sidebar/right-panel-comment-composer'
import { normalizePRCommentPath } from './pr-comment-inline-comments'
import type { PRCommentInlineThread } from './pr-comment-inline-threads'
import type { WorktreePRCommentInline } from './worktree-pr-comment-inline'

/**
 * Everything one editor surface needs to draw and act on a file's review threads.
 *
 * `threads` is null when the file carries no threads or the head rule forbids placing them, which
 * is the single signal a surface checks before drawing anything.
 */
export type PRCommentInlineSurface = {
  scope: string | null
  threads: readonly PRCommentInlineThread[] | null
  /** The global setting: expands threads by default when on. */
  enabled: boolean
  onReply?: (thread: PRCommentInlineThread, body: string) => Promise<RightPanelCommentSubmitResult>
  onResolveThread?: (threadId: string, resolve: boolean) => Promise<boolean>
  pendingRevealCommentId: string | null
  onPendingRevealConsumed: () => void
}

export function usePRCommentInlineReviewActions(
  review: WorktreePRCommentInline | null
): Pick<PRCommentInlineSurface, 'onReply' | 'onResolveThread'> {
  const addPRReviewCommentReply = useAppStore((s) => s.addPRReviewCommentReply)
  const resolveReviewThread = useAppStore((s) => s.resolveReviewThread)
  const target = review?.reviewTarget ?? null

  // Why: replying reuses the store's own optimistic-then-reconcile path, so the Checks pane —
  // which reads the same comments cache — shows the reply without either surface notifying the other.
  const onReply = useMemo(() => {
    if (!target) {
      return undefined
    }
    return async (
      thread: PRCommentInlineThread,
      body: string
    ): Promise<RightPanelCommentSubmitResult> => {
      const result = await addPRReviewCommentReply(
        target.repoPath,
        target.prNumber,
        thread.root.id,
        body,
        {
          repoId: target.repoId,
          prRepo: target.prRepo,
          threadId: thread.threadId,
          path: thread.path,
          // Why: GitHub anchors a reply to a review comment; the line travels along so a client
          // that resolves the anchor server-side still lands on the commented line.
          line: thread.line
        }
      )
      return result.ok ? { ok: true } : { ok: false, error: result.error }
    }
  }, [addPRReviewCommentReply, target])

  const onResolveThread = useMemo(() => {
    if (!target) {
      return undefined
    }
    return (threadId: string, resolve: boolean): Promise<boolean> =>
      resolveReviewThread(target.repoPath, target.prNumber, threadId, resolve, {
        repoId: target.repoId,
        prRepo: target.prRepo
      })
  }, [resolveReviewThread, target])

  return { onReply, onResolveThread }
}

/**
 * Binds a worktree review to one file.
 *
 * Kept as a hook so both the plain file editor and a worktree diff tab reach the same thread set
 * through the same path normalisation — GitHub always names a path with `/`, and an editor surface
 * may not.
 */
export function usePRCommentInlineSurface(
  review: WorktreePRCommentInline | null,
  filePath: string
): PRCommentInlineSurface | null {
  const { onReply, onResolveThread } = usePRCommentInlineReviewActions(review)
  const scrollToDiffCommentId = useAppStore((s) => s.scrollToDiffCommentId)
  const setScrollToDiffCommentId = useAppStore((s) => s.setScrollToDiffCommentId)
  const scope = review?.scope ?? null
  const enabled = review?.enabled ?? false
  const threads = review?.inlineThreadsByPath?.get(normalizePRCommentPath(filePath)) ?? null

  const onPendingRevealConsumed = useCallback((): void => {
    setScrollToDiffCommentId(null)
  }, [setScrollToDiffCommentId])

  return useMemo(
    () =>
      scope === null
        ? null
        : {
            scope,
            threads,
            enabled,
            onReply,
            onResolveThread,
            pendingRevealCommentId: scrollToDiffCommentId,
            onPendingRevealConsumed
          },
    [
      enabled,
      onPendingRevealConsumed,
      onReply,
      onResolveThread,
      scope,
      scrollToDiffCommentId,
      threads
    ]
  )
}
