import type { GlobalSettings } from '../../../shared/global-settings-types'

/** PR review threads inline in code are on unless the user has explicitly turned them off. */
export function isPRCommentsInlineEnabled(
  settings: Pick<GlobalSettings, 'prCommentsInlineEnabled'> | null | undefined
): boolean {
  // Why: settings hydrate async; only an explicit off hides the threads, so they never flicker on launch.
  return settings?.prCommentsInlineEnabled !== false
}
