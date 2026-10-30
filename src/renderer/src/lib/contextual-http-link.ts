import { openHttpLink } from './http-link-routing'

export type ContextualHttpLinkOptions = {
  /** Workspace the link opens into; null falls back to the OS browser. */
  worktreeId: string | null
  /** The platform escape-hatch modifier (Shift) was held. */
  modifierHeld?: boolean
  /** An explicit menu choice beats the stored preference. */
  forceDestination?: 'orca' | 'system'
}

/**
 * Opens a web link that arrived outside a link-aware surface — a plain anchor, a `window.open`, a
 * bridge call, or a right-click menu row. The user's link-routing preference names the destination.
 */
export function openContextualHttpLink(url: string, opts: ContextualHttpLinkOptions): void {
  openHttpLink(url, {
    worktreeId: opts.worktreeId,
    allowRemoteInApp: true,
    ...(opts.modifierHeld ? { modifierHeld: true } : {}),
    ...(opts.forceDestination === 'orca' ? { forceInApp: true } : {}),
    ...(opts.forceDestination === 'system' ? { forceSystemBrowser: true } : {})
  })
}
