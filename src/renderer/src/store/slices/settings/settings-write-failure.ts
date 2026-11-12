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
export function settingsWriteFailureHostName(args: {
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

function notifySettingsWriteFailure(args: { error: unknown; hostName: string | null }): void {
  const { hostName } = args
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

/**
 * Main can hold a newer value than the store when a write rejects after it committed, and a newer
 * write's fence can drop an earlier successful one, so reconcile every key main reports.
 */
async function restoreSettingsAfterFailedWrite(args: {
  set: SettingsStateSetter
  shouldPublish: () => boolean
}): Promise<void> {
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
    for (const key of Object.keys(stored)) {
      if (RESTORE_SKIPPED_KEYS.has(key) || !isStoredSettingsKey(current, key)) {
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
  /** Captured before the write, because the host picker can move while a slow write is in flight. */
  hostName: string | null
  set: SettingsStateSetter
}): void {
  console.error('Failed to update settings:', args.error)
  const shouldPublish = observeSettingsPublicationGeneration()
  notifySettingsWriteFailure({ error: args.error, hostName: args.hostName })
  // Why: a draft-based control cannot see a rejected write through its value prop alone.
  args.set((state) => ({ settingsWriteFailureRevision: state.settingsWriteFailureRevision + 1 }))
  void restoreSettingsAfterFailedWrite({ set: args.set, shouldPublish })
}
