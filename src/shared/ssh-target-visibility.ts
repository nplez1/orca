import type { SshTarget } from './ssh-types'

// Split out of ssh-types.ts: upstream keeps that file on the max-lines budget, so the fork's
// visibility helpers live here and ssh-types.ts re-exports them.

export type SshTargetVisibilityInput = { id: string; hidden: boolean }

/**
 * Whether Orca discovered this host rather than the user adding it, which decides the
 * only lifecycle action offered: a discovered host is hidden (it comes back on every
 * ~/.ssh/config sync), a user-added one is removed.
 *
 * Why the shape check and not just `source`: targets persisted before `source` existed
 * carry the old import shape, where the SSH alias doubled as label and configHost while
 * host held the resolved HostName. Those are imported hosts too.
 */
export function isAutoImportedSshTarget(
  target: Pick<SshTarget, 'source' | 'label' | 'configHost' | 'host'>
): boolean {
  if (target.source === 'ssh-config') {
    return true
  }
  if (target.source !== undefined) {
    return false
  }
  const alias = target.configHost ?? target.label
  return Boolean(
    alias && target.label === alias && target.configHost === alias && target.host !== alias
  )
}

/** Hidden targets stay listed in Settings; every host picker drops them. */
export function isSshTargetHidden(target: Pick<SshTarget, 'hidden'>): boolean {
  return target.hidden === true
}
