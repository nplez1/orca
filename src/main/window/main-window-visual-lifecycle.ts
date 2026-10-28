import { ipcMain, type BrowserWindow } from 'electron'
import { recordMainUiHangSample } from '../diagnostics/ui-hang-log-sink'
import { isMacosTahoeOrNewer } from './macos-tahoe-release'

const activeRepaintJiggles = new WeakSet<BrowserWindow>()
const MIN_FOCUS_INVALIDATION_LOG_INTERVAL_MS = 1_000
let lastFocusInvalidationLoggedAtMs = Number.NEGATIVE_INFINITY

type FocusRepaintWindow = Pick<BrowserWindow, 'isDestroyed' | 'isVisible'> & {
  webContents: Pick<BrowserWindow['webContents'], 'isDestroyed' | 'invalidate'>
}

export function invalidateMainWindowOnFocus(
  window: FocusRepaintWindow,
  isUiHangLoggingEnabled: boolean
): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) {
    return
  }
  const now = isUiHangLoggingEnabled ? performance.now() : null
  const startedAtMs =
    now !== null && now - lastFocusInvalidationLoggedAtMs >= MIN_FOCUS_INVALIDATION_LOG_INTERVAL_MS
      ? now
      : null
  try {
    window.webContents.invalidate()
  } finally {
    if (startedAtMs !== null) {
      try {
        const capturedAtMs = performance.now()
        lastFocusInvalidationLoggedAtMs = capturedAtMs
        recordMainUiHangSample({
          signal: 'handler',
          operation: 'window-focus-invalidate',
          durationMs: Math.max(0, capturedAtMs - startedAtMs),
          surface: 'main',
          visible: !window.isDestroyed() && window.isVisible(),
          capturedAtMs
        })
      } catch {
        // Diagnostics must never interfere with window focus.
      }
    }
  }
}

export function forceRepaint(window: BrowserWindow): void {
  // Timers/focus callbacks can run after WebContents dies but before BrowserWindow closes; guard both.
  if (window.isDestroyed() || window.webContents.isDestroyed()) {
    return
  }
  window.webContents.invalidate()
  // macOS 26 scene-backed frame writes deadlock; avoid device-emulation wake traps too. Native shell sizing no longer needs dvh reflow.
  if (isMacosTahoeOrNewer()) {
    return
  }
  if (window.isMaximized() || window.isFullScreen() || activeRepaintJiggles.has(window)) {
    return
  }
  activeRepaintJiggles.add(window)
  // AppKit show/restore dispatch cannot safely mutate its own scene; nudge in a fresh turn.
  setTimeout(() => {
    if (window.isDestroyed()) {
      activeRepaintJiggles.delete(window)
      return
    }
    const [width, height] = window.getSize()
    // Clear the WeakSet even on native failure or this window can never repaint again.
    try {
      window.setSize(width + 1, height)
    } catch {
      activeRepaintJiggles.delete(window)
      return
    }
    setTimeout(() => {
      try {
        if (!window.isDestroyed()) {
          const [currentWidth, currentHeight] = window.getSize()
          // Concurrent user resize owns the final bounds; never restore over it.
          if (currentWidth === width + 1 && currentHeight === height) {
            window.setSize(width, height)
          }
        }
      } finally {
        activeRepaintJiggles.delete(window)
      }
    }, 32)
  }, 0)
}

export function installMacosVisibilityRepaint(
  window: BrowserWindow,
  isUiHangLoggingEnabled: () => boolean = () => false
): void {
  let delayedRepaintTimer: ReturnType<typeof setTimeout> | null = null
  const repaintAfterVisibilityTransition = (): void => {
    forceRepaint(window)
    if (delayedRepaintTimer) {
      clearTimeout(delayedRepaintTimer)
    }
    // macOS compositor layers can restore late; repaint again after show/restore.
    delayedRepaintTimer = setTimeout(() => {
      delayedRepaintTimer = null
      forceRepaint(window)
    }, 250)
  }
  const clearDelayedRepaint = (): void => {
    if (delayedRepaintTimer) {
      clearTimeout(delayedRepaintTimer)
      delayedRepaintTimer = null
    }
  }

  // Occlusion reveal may emit neither show nor restore; accept only this window's renderer relay.
  const onRendererRevealed = (event: Electron.IpcMainEvent): void => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      return
    }
    if (event.sender !== window.webContents) {
      return
    }
    forceRepaint(window)
  }
  ipcMain.on('ui:window-revealed', onRendererRevealed)

  window.on('restore', repaintAfterVisibilityTransition)
  window.on('show', repaintAfterVisibilityTransition)
  // Occlusion uncover may emit only focus; invalidate without resizing terminals on Cmd+Tab.
  window.on('focus', () => {
    let loggingEnabled = false
    try {
      loggingEnabled = isUiHangLoggingEnabled()
    } catch {
      // A settings read must not block window focus.
    }
    invalidateMainWindowOnFocus(window, loggingEnabled)
  })
  window.on('closed', () => {
    clearDelayedRepaint()
    ipcMain.removeListener('ui:window-revealed', onRendererRevealed)
  })
}

// Center is 18 CSS px × zoom; 12px traffic lights start 6px above it.
export const TITLEBAR_CSS_CENTER = 18
export const TRAFFIC_LIGHT_RADIUS = 6
export const TRAFFIC_LIGHT_X = 16
export const MIN_WIDTH = 600
export const MIN_HEIGHT = 400

export function syncTrafficLightPosition(win: BrowserWindow, zoomFactor: number): void {
  if (process.platform !== 'darwin' || win.isDestroyed()) {
    return
  }
  const y = Math.round(TITLEBAR_CSS_CENTER * zoomFactor - TRAFFIC_LIGHT_RADIUS)
  win.setWindowButtonPosition({ x: TRAFFIC_LIGHT_X, y })
}
