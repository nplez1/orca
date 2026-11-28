import type { RuntimeClientEvent } from '../../shared/remote-runtime/session-graph/runtime-client-events'

/** Where a local window learns that a worktree's setup runner started or ended. */
export const SETUP_RUNNER_STATE_CHANNEL = 'runtime:worktreeSetupRunnerStateChanged'

type SetupRunnerWindowRuntime = {
  onClientEvent: (
    listener: (event: RuntimeClientEvent) => void,
    options: { consumesTerminalSideEffects: boolean }
  ) => () => void
  getSetupRunnerClientEventSnapshot: () => RuntimeClientEvent[]
}

type SetupRunnerWindow = {
  webContents: {
    send: (channel: string, payload: RuntimeClientEvent) => void
    isDestroyed: () => boolean
    on: (event: 'did-finish-load', listener: () => void) => unknown
  }
  on: (event: 'closed', listener: () => void) => unknown
}

/**
 * Carries the host's setting-up announcement to the local window.
 *
 * Why it needs its own channel: a local window is not a runtime environment, so
 * the renderer's client-event bridge never subscribes for it, and the window's
 * generic fan-out forwards only the events it has IPC for. Without this the
 * sidebar of the machine that runs the setup never sees the state.
 *
 * The replay covers a renderer reload: the host clears its own set when the
 * runner ends whoever is listening, so the snapshot is always the truth.
 */
export function attachSetupRunnerStateToWindow(
  window: SetupRunnerWindow,
  runtime: SetupRunnerWindowRuntime
): void {
  const { webContents } = window
  const send = (event: RuntimeClientEvent): void => {
    if (!webContents.isDestroyed()) {
      webContents.send(SETUP_RUNNER_STATE_CHANNEL, event)
    }
  }
  const detach = runtime.onClientEvent(
    (event) => {
      if (event.type === 'worktreeSetupRunnerState') {
        send(event)
      }
    },
    { consumesTerminalSideEffects: false }
  )
  const replay = (): void => {
    for (const event of runtime.getSetupRunnerClientEventSnapshot()) {
      send(event)
    }
  }
  webContents.on('did-finish-load', replay)
  window.on('closed', detach)
  replay()
}
