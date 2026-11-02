import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  GLOBAL_SETTINGS_HOST_SYNC_DISPOSITION,
  type SettingsFieldHostSyncDisposition
} from './host-sync-settings-disposition'

/** Keys a host applies from the main, either always or only when it holds nothing. */
export const SETTINGS_FIELDS_REPLICATED_TO_HOSTS = settingsFieldsWith('replicated')

export const SETTINGS_FIELDS_REPLICATED_ONLY_IF_EMPTY = settingsFieldsWith('replicatedOnlyIfEmpty')

export const SETTINGS_FIELDS_HOST_LOCAL = settingsFieldsWith('hostLocal')

/**
 * Why the explicit return type: the table has no `replicated`-free day, but indexing a literal object
 * narrows the union to the values actually present, and a filter for a value that is not there stops
 * compiling the moment the last one is reclassified.
 */
function settingsFieldsWith(
  disposition: SettingsFieldHostSyncDisposition
): (keyof GlobalSettings)[] {
  return Object.keys(GLOBAL_SETTINGS_HOST_SYNC_DISPOSITION)
    .filter(
      (field): field is keyof GlobalSettings => field in GLOBAL_SETTINGS_HOST_SYNC_DISPOSITION
    )
    .filter((field) => GLOBAL_SETTINGS_HOST_SYNC_DISPOSITION[field] === disposition)
}
