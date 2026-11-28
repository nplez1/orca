import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-list/feed/sidebar-inputs-switch'
import type { RuntimeClientEvent } from '../../../shared/remote-runtime/session-graph/runtime-client-events'

/** Where a local window learns that a worktree's setup runner started or ended. */
export const SETUP_RUNNER_STATE_CHANNEL = 'runtime:worktreeSetupRunnerStateChanged'

type ClientEventNoticeWindow = {
  webContents: {
    send: (channel: string, payload: unknown) => void
    isDestroyed: () => boolean
  }
  on: (event: 'closed', listener: () => void) => unknown
}

type ClientEventNoticeRuntime = {
  onClientEvent: (
    listener: (event: RuntimeClientEvent) => void,
    options: { consumesTerminalSideEffects: boolean }
  ) => () => void
}

/**
 * Carries the client events this window draws itself.
 *
 * Why they need a relay at all: a local window is not a runtime environment, so
 * the renderer's client-event bridge never subscribes for it and the messages
 * have no other way to reach it. Without the setting-up one, the sidebar of the
 * machine that runs a repo's setup script never shows "Setting up…".
 *
 * The window pulls the current setting-up set when its listener registers
 * (`runtime:getSetupRunnerState`), so a reload mid-setup cannot miss it.
 */
export function relayClientEventNoticesToWindow(
  window: ClientEventNoticeWindow,
  runtime: ClientEventNoticeRuntime
): void {
  const { webContents } = window
  const send = (channel: string, payload: unknown): void => {
    if (!webContents.isDestroyed()) {
      webContents.send(channel, payload)
    }
  }
  const detach = runtime.onClientEvent(
    (event) => {
      if (event.type === 'linearLinkedIssueUpdated') {
        send('linear:linkedIssueUpdated', event)
      } else if (ORCA_SIDEBAR_INPUTS_IS_MAIN && event.type === 'sidebarInputsChanged') {
        send('runtime:sidebarInputsChanged', event)
      } else if (event.type === 'worktreeSetupRunnerState') {
        send(SETUP_RUNNER_STATE_CHANNEL, event)
      }
    },
    { consumesTerminalSideEffects: false }
  )
  window.on('closed', detach)
}
