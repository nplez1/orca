import type { StateCreator } from 'zustand'
import type { AppState } from '../types'

/**
 * Worktrees whose repo setup script is still running.
 *
 * The setup runner is a shell script, not an agent, so it reports no agent
 * status — without this the sidebar could only see a live PTY and would render
 * the workspace as plain "Active". The execution host observes the runner and
 * pushes `worktreeSetupRunnerState`; the renderer keeps the latest per worktree.
 */
export type WorktreeSetupRunnerSlice = {
  setupRunningWorktreeIds: Record<string, true>
  setWorktreeSetupRunning: (worktreeId: string, running: boolean) => void
}

export const createWorktreeSetupRunnerSlice: StateCreator<
  AppState,
  [],
  [],
  WorktreeSetupRunnerSlice
> = (set) => ({
  setupRunningWorktreeIds: {},

  setWorktreeSetupRunning: (worktreeId, running) => {
    set((s) => {
      const isRunning = s.setupRunningWorktreeIds[worktreeId] === true
      // Why identity-stable: an unchanged flag must not re-render every card
      // that selects this slice.
      if (isRunning === running) {
        return s
      }
      if (running) {
        return { setupRunningWorktreeIds: { ...s.setupRunningWorktreeIds, [worktreeId]: true } }
      }
      const next = { ...s.setupRunningWorktreeIds }
      delete next[worktreeId]
      return { setupRunningWorktreeIds: next }
    })
  }
})
