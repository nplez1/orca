import { useCallback, useRef } from 'react'
import { detectLanguage } from '@/lib/language-detect'
import { joinPath } from '@/lib/path'
import { useAppStore } from '@/store'
import { getOpenedEditFileIdAfterOpen } from '@/store/slices/editor/file-ids/editor-file-ids'
import type {
  GitBranchChangeEntry,
  GitBranchCompareSummary
} from '../../../../shared/git-diff-compare-types'
import type { PRComment } from '../../../../shared/github/comment-types'
import { canUseChangesModeForFile } from '../editor/editor-panel-file-mode'
import { getCompareBaseCandidateBranchName } from '../../../../shared/source-control-base-ref-resolution'
import { getPRCommentInlineId } from './pr-comment-inline-threads'
import {
  cancelSourceControlEditorRevealFrames,
  requestSourceControlEditorRevealFrame
} from '../right-sidebar/source-control/notes/editor-reveal-frames'

/** Where a comment can be shown in the code. */
export type PRCommentCodeTarget = {
  /** Repo-relative path, exactly as GitHub reports it. */
  relativePath: string
  line: number
}

/**
 * A changed row as the review names it, including the old side of a rename.
 *
 * GitHub keeps reporting the pre-rename path for a thread that started before the rename, so
 * matching only the new path would silently lose the file it belongs to.
 */
function matchesCommentPath(
  entry: { path: string; oldPath?: string },
  relativePath: string
): boolean {
  return entry.path === relativePath || entry.oldPath === relativePath
}

/**
 * The line a comment can be opened at, or null when no line can be trusted.
 *
 * Only an outdated thread returns null: its line number belongs to a revision the provider no
 * longer maps, so there is nothing to scroll to. A checkout that has moved on is not a reason to
 * refuse — the comment still belongs to this file in this workspace.
 */
export function resolvePRCommentCodeTarget(
  comment: PRComment,
  worktreePath: string | null | undefined
): PRCommentCodeTarget | null {
  if (comment.isOutdated) {
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
 * The editor surface a comment should land on, ranked by how many of the lines it was written about
 * that surface can show.
 *
 * A thread is only readable against the code it reviews, so the branch diff — merge base to head,
 * which is the review's own diff — comes first; Changes mode carries the uncommitted hunks; and a
 * plain tab is the answer only once a compare against the review's own base proves the file is
 * outside the review, because then this worktree holds no hunks for it at all.
 */
export type PRCommentCodeSurface =
  | { kind: 'branch-diff'; entry: GitBranchChangeEntry; compare: GitBranchCompareSummary }
  | { kind: 'changes' }

export function resolvePRCommentCodeSurface({
  relativePath,
  reviewBaseRefName,
  branchCompare,
  branchChanges
}: {
  relativePath: string
  /** The review's base branch, or null when the provider did not name one. */
  reviewBaseRefName: string | null | undefined
  branchCompare: GitBranchCompareSummary | null | undefined
  branchChanges: readonly GitBranchChangeEntry[] | null | undefined
}): PRCommentCodeSurface {
  const reviewBase = reviewBaseRefName?.trim() || null
  // Why also the exact ref: a local base named `release/2.0` reads as `2.0` to the branch helper, and
  // that mismatch would cost the jump the surface it came for.
  // Why the namespace prefix too: a provider names a base branch without an owner, while the local
  // remote ref carries one — this fork's reviews target `main` on GitHub and `origin/nplez1/main` here,
  // and requiring the two names to be equal is what sent every such jump to the wrong view.
  const compareIsReviewBase = (baseRef: string): boolean => {
    if (reviewBase === null) {
      return true
    }
    const trimmed = baseRef.trim()
    if (trimmed === reviewBase) {
      return true
    }
    const candidate = getCompareBaseCandidateBranchName(trimmed)
    return candidate === reviewBase || candidate.endsWith(`/${reviewBase}`)
  }
  // Why the OIDs too: a diff tab with no compare OIDs silently renders an unstaged diff instead.
  const reviewDiffCompare =
    branchCompare?.status === 'ready' &&
    branchCompare.baseOid &&
    branchCompare.headOid &&
    branchCompare.mergeBase &&
    // Why: a compare against another base is some other diff, and its hunks would not be the review's.
    compareIsReviewBase(branchCompare.baseRef)
      ? branchCompare
      : null
  const entry = reviewDiffCompare
    ? branchChanges?.find((candidate) => matchesCommentPath(candidate, relativePath))
    : undefined
  if (reviewDiffCompare && entry) {
    return { kind: 'branch-diff', entry, compare: reviewDiffCompare }
  }
  // Why: Changes mode is the one diff surface every worktree file has, and it explains an empty
  // result with its own banner. A plain tab would hide the workspace's changes rather than show none.
  return { kind: 'changes' }
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
  reviewBaseRefName
}: {
  worktreeId: string | null | undefined
  worktreePath: string | null | undefined
  /** The review's base branch; a compare against any other base is not the review's diff. */
  reviewBaseRefName: string | null | undefined
}): (comment: PRComment) => boolean {
  const openFile = useAppStore((s) => s.openFile)
  const openBranchDiff = useAppStore((s) => s.openBranchDiff)
  const setEditorViewMode = useAppStore((s) => s.setEditorViewMode)
  const setPendingEditorReveal = useAppStore((s) => s.setPendingEditorReveal)
  const setScrollToDiffCommentId = useAppStore((s) => s.setScrollToDiffCommentId)
  const pendingRevealFramesRef = useRef<number[]>([])

  return useCallback(
    (comment: PRComment): boolean => {
      const target = resolvePRCommentCodeTarget(comment, worktreePath)
      if (!target || !worktreeId || !worktreePath) {
        return false
      }
      cancelSourceControlEditorRevealFrames(pendingRevealFramesRef)
      // Why: a previous jump for another file must not outlive this one, or the new file's decorator
      // would try to reveal a thread it does not have.
      setScrollToDiffCommentId(null)
      const absolutePath = joinPath(worktreePath, target.relativePath)
      const language = detectLanguage(target.relativePath)
      const beforeOpen = useAppStore.getState()
      const surface = resolvePRCommentCodeSurface({
        relativePath: target.relativePath,
        reviewBaseRefName,
        branchCompare: beforeOpen.gitBranchCompareSummaryByWorktree[worktreeId],
        branchChanges: beforeOpen.gitBranchChangesByWorktree[worktreeId]
      })
      // Why only an Edit tab consumes a line reveal; a diff surface scrolls to the thread by id, and
      // a stale line reveal would fire later if the user switched that tab to Edit.
      let lineRevealFileId: string | null = null
      if (surface.kind === 'branch-diff') {
        openBranchDiff(worktreeId, worktreePath, surface.entry, surface.compare, language)
      } else {
        openFile({
          filePath: absolutePath,
          relativePath: target.relativePath,
          worktreeId,
          language,
          mode: 'edit'
        })
        const afterOpen = useAppStore.getState()
        const fileId = getOpenedEditFileIdAfterOpen(afterOpen, absolutePath, worktreeId)
        const opened = afterOpen.openFiles.find((file) => file.id === fileId)
        // Why: Changes mode is keyed by file id, and that id is not the path for a remote owner (or
        // an occupied path) — a path-keyed write would leave the tab in plain Edit mode.
        const changesMode = !!opened && canUseChangesModeForFile(opened)
        setEditorViewMode(fileId, changesMode ? 'changes' : 'edit')
        if (!changesMode) {
          lineRevealFileId = fileId
        }
      }
      setPendingEditorReveal(null)
      const revealFileId = lineRevealFileId
      requestSourceControlEditorRevealFrame(pendingRevealFramesRef, () => {
        requestSourceControlEditorRevealFrame(pendingRevealFramesRef, () => {
          // Why: a diff surface scrolls to the thread by id; only a Monaco tab uses the line reveal.
          if (revealFileId !== null) {
            setPendingEditorReveal({
              fileId: revealFileId,
              filePath: absolutePath,
              line: target.line,
              column: 1,
              matchLength: 0
            })
          }
          setScrollToDiffCommentId(getPRCommentInlineId(comment.id))
        })
      })
      return true
    },
    [
      openBranchDiff,
      openFile,
      reviewBaseRefName,
      setEditorViewMode,
      setPendingEditorReveal,
      setScrollToDiffCommentId,
      worktreeId,
      worktreePath
    ]
  )
}
