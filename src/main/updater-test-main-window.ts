import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { vi } from 'vitest'
import type { UpdaterSpy } from './updater-test-harness'

export type UpdaterMainWindowFake = BrowserWindow & {
  /** Emits the native `closed` event without faking the destroyed flag Electron also sets. */
  close: () => void
  /** Both Electron teardown paths the updater has to survive, kept separable for tests. */
  destroyWindow: () => void
  destroyWebContents: () => void
}

/**
 * Minimal BrowserWindow stand-in: the updater binds to it, guards it and sends status through it.
 * Pass the `send` spy the test asserts on; teardown is driven through `close`/`destroy*`.
 */
export function createUpdaterMainWindow(send: UpdaterSpy = vi.fn()): UpdaterMainWindowFake {
  const events = new EventEmitter()
  let windowDestroyed = false
  let webContentsDestroyed = false
  const mainWindow = {
    webContents: {
      send,
      isDestroyed: () => webContentsDestroyed
    },
    isDestroyed: () => windowDestroyed,
    once: (event: string, listener: (...args: unknown[]) => void) => {
      events.once(event, listener)
      return mainWindow
    },
    close: () => {
      windowDestroyed = true
      events.emit('closed')
    },
    destroyWindow: () => {
      windowDestroyed = true
    },
    destroyWebContents: () => {
      webContentsDestroyed = true
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake carries only the members the updater binds to, guards and sends through.
  return mainWindow as unknown as UpdaterMainWindowFake
}
