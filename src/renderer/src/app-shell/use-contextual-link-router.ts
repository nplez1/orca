import { useEffect } from 'react'
import { openContextualHttpLink } from '@/lib/contextual-http-link'
import { useAppStore } from '@/store'

/**
 * Receives the web links main could not attribute to a surface — plain anchors, `window.open`
 * popups, and every `shell.openUrl` bridge call — and opens them the way the user's link-routing
 * preference says. Announcing readiness is what lets main stop opening them in the OS browser.
 */
export function useContextualLinkRouter(): void {
  useEffect(() => {
    // Subscribe before announcing, so the first relayed link cannot arrive with no listener.
    const unsubscribe = window.api.shell.onContextualLinkRequested((url) =>
      // Read at open time: the active workspace must not re-subscribe this listener.
      openContextualHttpLink(url, { worktreeId: useAppStore.getState().activeWorktreeId })
    )
    window.api.shell.markContextualLinkRouterReady()
    return unsubscribe
  }, [])
}
