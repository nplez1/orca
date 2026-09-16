import { scheduleAfterInputQuiet } from '@/lib/input-quiet-scheduler'
import {
  ACTIVE_WORKTREE_TERMINAL_PREP_DELAY_MS,
  ACTIVE_WORKTREE_TERMINAL_PREP_IDLE_TIMEOUT_MS,
  ACTIVE_WORKTREE_TERMINAL_PREP_INPUT_QUIET_MS
} from '../listing/worktree-slice-constants'
import { shouldDeferActivationTerminalPrep } from './activation-terminal-prep'

/** Schedules nonessential workspace hydration after the newly selected agent can accept input. */
export function scheduleAfterWorktreeActivationInputQuiet(callback: () => void): () => void {
  if (!shouldDeferActivationTerminalPrep()) {
    callback()
    return () => {}
  }

  return scheduleAfterInputQuiet(callback, {
    delayMs: ACTIVE_WORKTREE_TERMINAL_PREP_DELAY_MS,
    quietMs: ACTIVE_WORKTREE_TERMINAL_PREP_INPUT_QUIET_MS,
    idleTimeoutMs: ACTIVE_WORKTREE_TERMINAL_PREP_IDLE_TIMEOUT_MS
  })
}
