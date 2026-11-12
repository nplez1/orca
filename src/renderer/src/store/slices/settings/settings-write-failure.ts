import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { defaultScopeHost } from '@/runtime/hosts/selection/default-creation-host'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { AppState } from '../../types'
import type { SettingsStateSetter } from './settings-owner-hydration-publication'
import { observeSettingsPublicationGeneration } from './settings-owner-hydration-publication'

// Why: a second failure must replace the first, not stack a duplicate over it.
const SETTINGS_WRITE_FAILURE_TOAST_ID = 'settings-write-failed'

/** The visibility-defaults branch is the only settings write that reaches a paired host. */
function failedWriteHostName(args: {
  updates: Partial<GlobalSettings>
  settings: GlobalSettings | null
  runtimeEnvironments: AppState['runtimeEnvironments']
}): string | null {
  if (!('worktreeVisibilityDefaults' in args.updates)) {
    return null
  }
  const target = defaultScopeHost(args.settings)
  if (target.kind !== 'environment') {
    return null
  }
  return (
    args.runtimeEnvironments.find((environment) => environment.id === target.environmentId)?.name ??
    null
  )
}

function notifySettingsWriteFailure(args: {
  error: unknown
  updates: Partial<GlobalSettings>
  settings: GlobalSettings | null
  runtimeEnvironments: AppState['runtimeEnvironments']
}): void {
  const hostName = failedWriteHostName(args)
  toast.error(
    hostName
      ? translate(
          'auto.store.slices.settings.settings.write.failure.6f2c05896d',
          'Could not save the setting on {{host}}',
          { host: hostName }
        )
      : translate(
          'auto.store.slices.settings.settings.write.failure.df28bd1726',
          'Could not save the setting'
        ),
    {
      id: SETTINGS_WRITE_FAILURE_TOAST_ID,
      description: extractIpcErrorMessage(
        args.error,
        translate(
          'auto.store.slices.settings.settings.write.failure.88c496d7aa',
          'The change was not saved.'
        )
      )
    }
  )
}

const RESTORE_SKIPPED_KEYS = new Set<string>([
  // Why: the write already published the stored defaults it could read, and re-reading them
  // would fight the per-host merge.
  'worktreeVisibilityDefaults',
  // Why: main owns this preference, so a generic write can never change it.
  'activeRuntimeEnvironmentId'
])

function sameSettingsValue(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right)
}

function isStoredSettingsKey(settings: GlobalSettings, key: string): key is keyof GlobalSettings {
  return key in settings
}

/** Main can hold a newer value than the store when a write rejects after it committed. */
async function restoreSettingsAfterFailedWrite(args: {
  updates: Partial<GlobalSettings>
  set: SettingsStateSetter
  shouldPublish: () => boolean
}): Promise<void> {
  const keys = Object.keys(args.updates).filter((key) => !RESTORE_SKIPPED_KEYS.has(key))
  if (keys.length === 0) {
    return
  }
  let stored: GlobalSettings | null
  try {
    stored = await window.api.settings.get()
  } catch (error) {
    console.error('Failed to re-read settings after a failed update:', error)
    return
  }
  if (!stored || !args.shouldPublish()) {
    return
  }
  args.set((state) => {
    const current = state.settings
    if (!current) {
      return {}
    }
    let restored: GlobalSettings | null = null
    for (const key of keys) {
      if (!isStoredSettingsKey(stored, key)) {
        continue
      }
      const storedValue = stored[key]
      if (sameSettingsValue(current[key], storedValue)) {
        continue
      }
      restored = Object.assign(restored ?? { ...current }, { [key]: storedValue })
    }
    // Why: an unchanged object identity keeps settings effects from re-firing.
    return restored ? { settings: restored } : {}
  })
}

export function handleSettingsWriteFailure(args: {
  error: unknown
  updates: Partial<GlobalSettings>
  set: SettingsStateSetter
  get: () => AppState
}): void {
  console.error('Failed to update settings:', args.error)
  const shouldPublish = observeSettingsPublicationGeneration()
  const { settings, runtimeEnvironments } = args.get()
  notifySettingsWriteFailure({
    error: args.error,
    updates: args.updates,
    settings,
    runtimeEnvironments
  })
  // Why: a draft-based control cannot see a rejected write through its value prop alone.
  args.set((state) => ({ settingsWriteFailureRevision: state.settingsWriteFailureRevision + 1 }))
  void restoreSettingsAfterFailedWrite({ updates: args.updates, set: args.set, shouldPublish })
}
