import { expect, it, vi } from 'vitest'
import type { RuntimeClientEvent } from '../../../shared/remote-runtime/session-graph/runtime-client-events'
import {
  relayClientEventNoticesToWindow,
  SETUP_RUNNER_STATE_CHANNEL
} from './client-event-notice-relay'

const setupStarted = (worktreeId: string): RuntimeClientEvent => ({
  type: 'worktreeSetupRunnerState',
  worktreeId,
  running: true
})

function fakeWindow() {
  const listeners = new Set<(event: RuntimeClientEvent) => void>()
  const send = vi.fn()
  const windowHandlers = new Map<string, () => void>()
  const window = {
    webContents: { send, isDestroyed: () => false },
    on: (event: 'closed', listener: () => void) => {
      windowHandlers.set(event, listener)
    }
  }
  const runtime = {
    onClientEvent: (listener: (event: RuntimeClientEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  return { window, runtime, send, listeners, windowHandlers }
}

// A local window is not a runtime environment, so this relay is the only way its sidebar learns
// that a repo's setup runner started. It shipped missing once, which is what #87 reports.
it('relays the setup-runner state to the local window', () => {
  const { window, runtime, send, listeners } = fakeWindow()

  relayClientEventNoticesToWindow(window, runtime)
  for (const listener of listeners) {
    listener(setupStarted('wt-started'))
    listener({ type: 'reposChanged' })
  }

  expect(send.mock.calls).toEqual([[SETUP_RUNNER_STATE_CHANNEL, setupStarted('wt-started')]])
})

it('keeps relaying the linked Linear issue notice and ignores events it has no channel for', () => {
  const { window, runtime, send, listeners } = fakeWindow()

  relayClientEventNoticesToWindow(window, runtime)
  for (const listener of listeners) {
    listener({
      type: 'linearLinkedIssueUpdated',
      worktreeId: 'wt-1',
      workspaceId: 'ws-1',
      identifier: 'ENG-1'
    })
    listener({ type: 'reposChanged' })
  }

  expect(send.mock.calls).toEqual([
    ['linear:linkedIssueUpdated', expect.objectContaining({ identifier: 'ENG-1' })]
  ])
})

it('stops relaying once the window closes', () => {
  const { window, runtime, listeners, windowHandlers } = fakeWindow()

  relayClientEventNoticesToWindow(window, runtime)
  windowHandlers.get('closed')!()

  expect(listeners.size).toBe(0)
})
