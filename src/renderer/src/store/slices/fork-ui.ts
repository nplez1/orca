import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { PRCommentInlineDisplay } from '@/lib/pr-comment-inline-display'

/** Where the project menu wants the Available Hosts add flow opened, for which host, and from
 *  which of the project's repo rows (several checkouts can share one project). */
export type ProjectHostAddRequest = {
  projectId: string
  repoId: string
  hostId: ExecutionHostId
}

/**
 * The fork's transient renderer state, kept out of upstream's UI slice. Nothing here is
 * persisted or hydrated: no window.api.ui.set, and absent from the debounced UI writer.
 *
 * One fork line stays in upstream's `ui-slice-settings-actions.ts`: `closeSettingsPage` clears
 * `settingsProjectAddHostRequest`, because that is where the page it belongs to is closed. Moving the
 * clear here would need a subscription to upstream's view state for one field.
 */
export type ForkUiSlice = {
  /** One-shot "add this project to that host" request from the sidebar's Add to… menu, carried
   *  into Settings → Available Hosts because the add flow lives there. */
  settingsProjectAddHostRequest: ProjectHostAddRequest | null
  requestProjectHostAdd: (request: ProjectHostAddRequest) => void
  clearProjectHostAddRequest: () => void
  /**
   * Per-thread expand/collapse choices, keyed by inline comment id.
   *
   * Session-only by design: hiding one distracting thread is a reaction to what is on screen right
   * now, not a preference worth persisting. The global setting is the durable half of the pair.
   */
  prCommentInlineDisplayById: Record<string, PRCommentInlineDisplay>
  setPRCommentInlineDisplay: (commentId: string, display: PRCommentInlineDisplay | null) => void
  /**
   * Which of a workspace's reviews the Checks and Source Control panes describe, keyed by worktree.
   *
   * A workspace can hold several review attachments while its compatibility slots name only one
   * active review, and switching the shown one must not move that slot: the slot is what push-target
   * and PR-creation safety resolve through, so pointing it at another branch's review would retarget
   * a push. Session-only, and shared between both panes so they cannot disagree about which review
   * is selected.
   */
  workspaceReviewSelectionByWorktree: Record<string, string>
  selectWorkspaceReview: (worktreeId: string, reviewKey: string | null) => void
}

export const createForkUiSlice: StateCreator<AppState, [], [], ForkUiSlice> = (set) => ({
  settingsProjectAddHostRequest: null,
  // Why: a fresh object per request, so asking for the same host twice re-opens the flow.
  requestProjectHostAdd: (request) => set({ settingsProjectAddHostRequest: { ...request } }),
  clearProjectHostAddRequest: () => set({ settingsProjectAddHostRequest: null }),
  prCommentInlineDisplayById: {},
  setPRCommentInlineDisplay: (commentId, display) =>
    set((state) => {
      const next = { ...state.prCommentInlineDisplayById }
      // Why: null drops the choice so the thread falls back to its derived default (resolved
      // threads collapsed, the rest following the global setting) instead of pinning it.
      if (display === null) {
        delete next[commentId]
      } else {
        next[commentId] = display
      }
      return { prCommentInlineDisplayById: next }
    }),
  workspaceReviewSelectionByWorktree: {},
  selectWorkspaceReview: (worktreeId, reviewKey) =>
    set((state) => {
      const next = { ...state.workspaceReviewSelectionByWorktree }
      // Why: null drops the choice so the panes fall back to the workspace's own review instead of
      // pinning a review the user unlinked.
      if (reviewKey === null) {
        delete next[worktreeId]
      } else {
        next[worktreeId] = reviewKey
      }
      return { workspaceReviewSelectionByWorktree: next }
    })
})
