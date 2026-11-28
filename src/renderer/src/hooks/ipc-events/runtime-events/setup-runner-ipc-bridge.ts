import { useAppStore } from '../../../store/index'

/**
 * The local window's setting-up announcement.
 *
 * A paired host's copy arrives through the runtime client-event bridge; this
 * machine's own runtime is not an environment, so it has its own channel. Both
 * land in the same store flag the sidebar reads.
 */
export function registerSetupRunnerIpcBridge(unsubs: (() => void)[]): void {
  const onSetupRunnerStateChanged = window.api?.runtime?.onWorktreeSetupRunnerStateChanged
  if (!onSetupRunnerStateChanged) {
    return
  }
  unsubs.push(
    onSetupRunnerStateChanged((event) => {
      useAppStore.getState().setWorktreeSetupRunning(event.worktreeId, event.running)
    })
  )
}
