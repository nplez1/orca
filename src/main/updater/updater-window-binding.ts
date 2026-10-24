import type { BrowserWindow } from 'electron'
import type { UpdaterRendererChannel } from './updater-types'
import { recordUpdaterLifecycle } from '../updater-lifecycle-diagnostics'
import { INITIAL_UPDATE_STATUS, UpdaterState } from './updater-state'

/** Owns the main-window binding every updater send and window-parented dialog goes through. */
export abstract class UpdaterWindowBinding extends UpdaterState {
  /**
   * Binds the window updater events are sent to and replays the current status, which may have
   * landed while the previous window was already gone.
   */
  protected bindMainWindow(mainWindow: BrowserWindow): void {
    this.mainWindowRef = mainWindow
    mainWindow.once('closed', () => this.releaseMainWindow(mainWindow))
    // Why: only the untouched default is skipped — the renderer already starts from it, while every
    // recorded status, idle included, is one the new renderer has no other way to learn.
    if (this.currentStatus !== INITIAL_UPDATE_STATUS) {
      this.sendToMainWindow('updater:status', this.currentStatus)
    }
  }

  /** Drops the binding on close, unless a newer window already replaced it. */
  protected releaseMainWindow(mainWindow: BrowserWindow): void {
    if (this.mainWindowRef === mainWindow) {
      this.mainWindowRef = null
    }
  }

  /** The bound window while it is still alive, so native UI is never parented to a destroyed one. */
  protected liveMainWindow(): BrowserWindow | null {
    const target = this.mainWindowRef
    return target && !target.isDestroyed() ? target : null
  }

  /** Returns whether the message landed; a window closed mid-cycle is a dropped send, never a throw. */
  protected sendToMainWindow(channel: UpdaterRendererChannel, ...args: unknown[]): boolean {
    const target = this.liveMainWindow()
    if (!target || target.webContents.isDestroyed()) {
      return false
    }
    try {
      target.webContents.send(channel, ...args)
      return true
    } catch (error) {
      // Why: the window can go away between the guard and the send; the next bind replays the status,
      // and the failure stays visible instead of disappearing silently.
      recordUpdaterLifecycle(
        'renderer_send_failed',
        { channel, errorType: error instanceof Error ? error.name : typeof error },
        { level: 'warn', message: 'Updater could not send to the main window' }
      )
      return false
    }
  }
}
