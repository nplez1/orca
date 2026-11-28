import { expect, it, vi } from 'vitest'
import type { RuntimeClientEvent } from '../../shared/remote-runtime/session-graph/runtime-client-events'
import {
  attachSetupRunnerStateToWindow,
  SETUP_RUNNER_STATE_CHANNEL
} from './setup-runner-window-forwarding'

const started = (worktreeId: string): RuntimeClientEvent => ({
  type: 'worktreeSetupRunnerState',
  worktreeId,
  running: true
})

function fakeWindow(runningSnapshot: RuntimeClientEvent[]) {
  const listeners = new Set<(event: RuntimeClientEvent) => void>()
  const send = vi.fn()
  const webContentsHandlers = new Map<string, () => void>()
  const windowHandlers = new Map<string, () => void>()
  const window = {
    webContents: {
      send,
      isDestroyed: () => false,
      on: (event: 'did-finish-load', listener: () => void) => {
        webContentsHandlers.set(event, listener)
      }
    },
    on: (event: 'closed', listener: () => void) => {
      windowHandlers.set(event, listener)
    }
  }
  const runtime = {
    onClientEvent: (listener: (event: RuntimeClientEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSetupRunnerClientEventSnapshot: () => runningSnapshot
  }
  return { window, runtime, send, listeners, webContentsHandlers, windowHandlers }
}

// The local window is not a runtime environment, so this channel is the only way the sidebar of
// the machine running the setup learns that a runner started. It shipped missing once already.
it('carries the host announcement to the local window and replays it after a reload', () => {
  const { window, runtime, send, listeners, webContentsHandlers } = fakeWindow([
    started('wt-running')
  ])

  attachSetupRunnerStateToWindow(window, runtime)

  expect(send.mock.calls).toEqual([[SETUP_RUNNER_STATE_CHANNEL, started('wt-running')]])

  for (const listener of listeners) {
    listener(started('wt-started'))
    listener({ type: 'reposChanged' })
  }
  expect(send.mock.calls.at(-1)).toEqual([SETUP_RUNNER_STATE_CHANNEL, started('wt-started')])
  expect(send).toHaveBeenCalledTimes(2)

  webContentsHandlers.get('did-finish-load')!()
  expect(send).toHaveBeenCalledTimes(3)
  expect(send.mock.calls.at(-1)).toEqual([SETUP_RUNNER_STATE_CHANNEL, started('wt-running')])
})

it('stops forwarding once the window closes', () => {
  const { window, runtime, listeners, windowHandlers } = fakeWindow([])

  attachSetupRunnerStateToWindow(window, runtime)
  windowHandlers.get('closed')!()

  expect(listeners.size).toBe(0)
})

it('sends nothing to a destroyed window', () => {
  const send = vi.fn()
  const window = {
    webContents: { send, isDestroyed: () => true, on: () => {} },
    on: () => {}
  }

  attachSetupRunnerStateToWindow(window, {
    onClientEvent: (listener) => {
      listener(started('wt-gone'))
      return () => {}
    },
    getSetupRunnerClientEventSnapshot: () => [started('wt-gone')]
  })

  expect(send).not.toHaveBeenCalled()
})
