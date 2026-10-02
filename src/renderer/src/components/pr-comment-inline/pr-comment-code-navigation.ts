import { useCallback, useRef } from 'react'
import { detectLanguage } from '@/lib/language-detect'
import { joinPath } from '@/lib/path'
import { useAppStore } from '@/store'
import type { PRComment } from '../../../../shared/github/comment-types'
import { getPRCommentInlineId } from './pr-comment-inline-threads'
import {
  cancelSourceControlEditorRevealFrames,
  requestSourceControlEditorRevealFrame
} from '../right-sidebar/source-control/notes/editor-reveal-frames'

/** Where a Checks-pane comment can be shown in the code. */
export type PRCommentCodeTarget = {
  /** Repo-relative path, exactly as GitHub reports it. */
  relativePath: string
  line: number
}

/**
 * The line a comment can be opened at, or null when opening it in code would be a lie.
 *
 * Outdated threads keep their original line number, and a worktree whose head is not the PR's head
 * cannot say where the line moved to. Both cases return null so the caller falls back to opening the
 * comment on the provider instead of scrolling to unrelated code.
 */
export function resolvePRCommentCodeTarget(
  comment: PRComment,
  worktreePath: string | null | undefined,
  placementAllowed: boolean
): PRCommentCodeTarget | null {
  if (!placementAllowed || comment.isOutdated) {
    return null
  }
  const relativePath = comment.path
  const line = comment.line
  if (!relativePath || typeof line !== 'number' || !worktreePath?.trim()) {
    return null
  }
  return { relativePath, line }
}

/**
 * Opens a review comment in the code and asks the inline decorator to reveal its thread.
 *
 * The reveal is stamped rather than passed as a prop because opening the file can remount Monaco,
 * and the id survives that remount where a one-shot prop would not. `setPendingEditorReveal` is
 * deferred two frames for the same reason the local-note flow defers it.
 */
export function usePRCommentCodeNavigation({
  worktreeId,
  worktreePath,
  placementAllowed
}: {
  worktreeId: string | null | undefined
  worktreePath: string | null | undefined
  /** False when the head rule forbids placing comments, which makes the jump fall back to GitHub. */
  placementAllowed: boolean
}): (comment: PRComment) => boolean {
  const openFile = useAppStore((s) => s.openFile)
  const setEditorViewMode = useAppStore((s) => s.setEditorViewMode)
  const setPendingEditorReveal = useAppStore((s) => s.setPendingEditorReveal)
  const setScrollToDiffCommentId = useAppStore((s) => s.setScrollToDiffCommentId)
  const pendingRevealFramesRef = useRef<number[]>([])

  return useCallback(
    (comment: PRComment): boolean => {
      const target = resolvePRCommentCodeTarget(comment, worktreePath, placementAllowed)
      if (!target || !worktreeId || !worktreePath) {
        return false
      }
      cancelSourceControlEditorRevealFrames(pendingRevealFramesRef)
      // Why: a previous jump for another file must not outlive this one, or the new file's decorator
      // would try to reveal a thread it does not have.
      setScrollToDiffCommentId(null)
      const absolutePath = joinPath(worktreePath, target.relativePath)
      openFile({
        filePath: absolutePath,
        relativePath: target.relativePath,
        worktreeId,
        language: detectLanguage(target.relativePath),
        mode: 'edit'
      })
      setEditorViewMode(absolutePath, 'edit')
      setPendingEditorReveal(null)
      requestSourceControlEditorRevealFrame(pendingRevealFramesRef, () => {
        requestSourceControlEditorRevealFrame(pendingRevealFramesRef, () => {
          setPendingEditorReveal({
            filePath: absolutePath,
            line: target.line,
            column: 1,
            matchLength: 0
          })
          setScrollToDiffCommentId(getPRCommentInlineId(comment.id))
        })
      })
      return true
    },
    [
      openFile,
      placementAllowed,
      setEditorViewMode,
      setPendingEditorReveal,
      setScrollToDiffCommentId,
      worktreeId,
      worktreePath
    ]
  )
}
