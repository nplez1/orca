import { useAppStore } from '../../../store/index'

/**
 * The local window's setting-up announcement.
 *
 * A paired host's copy arrives through the runtime client-event bridge; this
 * machine's own runtime is not an environment, so it has its own channel. Both
 * land in the same store flag the sidebar reads.
 *
 * The pull is what makes a reload during setup safe: a pushed event can arrive
 * before this listener exists, and the host's set is the truth either way.
 */
export function registerSetupRunnerIpcBridge(unsubs: (() => void)[]): void {
  const runtime = window.api?.runtime
  const onSetupRunnerStateChanged = runtime?.onWorktreeSetupRunnerStateChanged
  if (!onSetupRunnerStateChanged) {
    return
  }
  let active = true
  const applyRunning = (event: { worktreeId: string; running: boolean }): void => {
    useAppStore.getState().setWorktreeSetupRunning(event.worktreeId, event.running)
  }
  const unsubscribe = onSetupRunnerStateChanged(applyRunning)
  unsubs.push(() => {
    active = false
    unsubscribe()
  })
  void runtime.getSetupRunnerState().then(
    (events) => {
      if (!active) {
        return
      }
      for (const event of events) {
        if (event.type === 'worktreeSetupRunnerState') {
          applyRunning(event)
        }
      }
    },
    () => {}
  )
}
