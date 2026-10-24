import type { BrowserWindow } from 'electron'
import type { UpdaterRendererChannel } from './updater-types'
import { UpdaterState } from './updater-state'

/** Owns the main-window binding every updater send and window-parented dialog goes through. */
export abstract class UpdaterWindowBinding extends UpdaterState {
  /**
   * Binds the window updater events are sent to and replays the current status, which may have
   * landed while the previous window was already gone.
   */
  protected bindMainWindow(mainWindow: BrowserWindow): void {
    this.mainWindowRef = mainWindow
    mainWindow.once('closed', () => this.releaseMainWindow(mainWindow))
    // Why: a status that landed while the previous window was gone was recorded but never sent; the
    // untouched default is already the renderer's own initial status, so replaying it is only noise.
    if (this.currentStatus.state !== 'idle') {
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
    } catch {
      // Why: the window can go away between the guard and the send; the next bind replays currentStatus.
      return false
    }
  }
}
