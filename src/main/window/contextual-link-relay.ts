import { ipcMain } from 'electron'
import {
  contextualLinkOpenChannel,
  contextualLinkRouterReadyChannel
} from '../../shared/contextual-link-channels'

type ContextualLinkTarget = Pick<Electron.WebContents, 'id' | 'isDestroyed' | 'send'>

// Why a handshake: a window that has not mounted its router must still open links, and a
// dropped `send` would silently swallow the click. Readiness is per webContents, so a renderer
// reload re-announces itself from its mount effect.
const routersReadyForLinkOpens = new WeakSet<ContextualLinkTarget>()

export function markContextualLinkRouterReady(contents: ContextualLinkTarget): void {
  routersReadyForLinkOpens.add(contents)
}

export function isContextualLinkRouterReady(contents: ContextualLinkTarget): boolean {
  return routersReadyForLinkOpens.has(contents)
}

/**
 * Drops a window's announcement. A reload or a crash leaves the old document's listener gone, so a
 * stale entry would send the next link into a renderer that cannot receive it.
 */
export function forgetContextualLinkRouter(contents: ContextualLinkTarget): void {
  routersReadyForLinkOpens.delete(contents)
}

/**
 * Hands `url` to the window's router, which applies the user's link-routing preference.
 * Returns false when the caller must fall back to the system browser itself.
 */
export function relayContextualLink(contents: ContextualLinkTarget, url: string): boolean {
  // An unannounced or destroyed window would drop the click, so the caller opens it instead.
  if (!routersReadyForLinkOpens.has(contents) || contents.isDestroyed()) {
    return false
  }
  contents.send(contextualLinkOpenChannel, url)
  return true
}

export function registerContextualLinkRouterHandshake(): void {
  ipcMain.on(contextualLinkRouterReadyChannel, (event) => {
    markContextualLinkRouterReady(event.sender)
  })
}
