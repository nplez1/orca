import type { GlobalSettings } from './global-settings-types'

type LinkRoutingSettings = Pick<
  GlobalSettings,
  'openLinksInApp' | 'openLinksInAppPreferencePrompted' | 'openLinksInAppDefaultedOnForAllUsers'
>

/**
 * Links open in Orca's per-worktree browser unless the user says otherwise. Profiles saved before
 * that default wrote `false`, which is indistinguishable from a deliberate choice to keep links
 * external, so the stamp is what lets an informed opt-out survive this one-time default flip.
 */
export function normalizeLinkRoutingDefaultInApp(
  settings: Partial<LinkRoutingSettings> | undefined
): LinkRoutingSettings {
  const stamped = settings?.openLinksInAppDefaultedOnForAllUsers === true
  return {
    openLinksInApp: stamped ? (settings?.openLinksInApp ?? true) : true,
    // Nothing left to ask: the default is already the answer the prompt offered.
    openLinksInAppPreferencePrompted: true,
    openLinksInAppDefaultedOnForAllUsers: true
  }
}
