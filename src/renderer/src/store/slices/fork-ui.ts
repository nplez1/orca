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
    })
})
