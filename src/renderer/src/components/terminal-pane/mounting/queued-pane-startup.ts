import type { PtyPaneStartup } from '../pty-connection/startup/pty-pane-startup'

export function paneOwnsQueuedStartup(
  paneStartup: PtyPaneStartup | null | undefined,
  queuedStartup: PtyPaneStartup | null | undefined
): boolean {
  return queuedStartup != null && paneStartup === queuedStartup
}

export function createQueuedStartupConsumer(
  paneStartup: PtyPaneStartup | null | undefined,
  queuedStartup: PtyPaneStartup | null | undefined,
  consume: (ptyId: string) => void,
  isStillQueued: () => boolean
): ((ptyId: string) => void) | undefined {
  if (!paneOwnsQueuedStartup(paneStartup, queuedStartup)) {
    return undefined
  }
  let spent = false
  return (ptyId) => {
    if (spent) {
      return
    }
    spent = true
    if (!isStillQueued()) {
      return
    }
    consume(ptyId)
  }
}
