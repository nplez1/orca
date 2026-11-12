import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { toast } from 'sonner'
import {
  clearRuntimeCompatibilityCache,
  markRuntimeEnvironmentCompatible
} from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { unwrapRuntimeRpcResult } from '@/runtime/rpc/calls/runtime-rpc-result'
import { assertRuntimeStatusCompatible } from '@/runtime/rpc/compatibility/runtime-protocol-compat'
import type { RuntimeStatus } from '../../../../../shared/runtime-session-contracts'
import { createSettingsSearchState, type SettingsSearchState } from './settings-search-state'
import {
  enablesNewTuiAgents,
  refreshDetectedAgentInventories
} from '../agent-enablement-redetection'
import { isRuntimeCatalogListingStale } from '../runtime-status/runtime-status-hydration'
import { bumpProviderRuntimeSessionGeneration } from '@/runtime/hosts/observations/provider-runtime-context'
import { translate } from '@/i18n/i18n'
import {
  hydrateOwnerWorktreeVisibilityDefaults,
  type WorktreeVisibilityDefaultsByHost
} from './worktree-visibility-owner-settings'
import * as ownerHydration from './settings-owner-hydration-publication'
import { persistVisibilityAwareSettings } from './worktree-visibility-settings-write'
import { getSettingsFocusedExecutionHostId } from '../../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { handleSettingsWriteFailure, settingsWriteFailureHostName } from './settings-write-failure'
import { normalizeSettingsUpdates } from './settings-update-normalization'

export type SettingsSlice = SettingsSearchState & {
  settings: GlobalSettings | null
  /** Increments on every rejected settings write so a draft-based control can drop a value that did not save. */
  settingsWriteFailureRevision: number
  worktreeVisibilityDefaultsByHost: WorktreeVisibilityDefaultsByHost
  worktreeVisibilityDefaultsSupportedRuntimeEnvironmentId: string | null
  worktreeVisibilitySourceDefaultsSupportedRuntimeEnvironmentId: string | null
  fetchSettings: (options?: ownerHydration.FetchSettingsOptions) => Promise<void>
  awaitOwnerWorktreeVisibilityDefaultsHydration: () => Promise<void>
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
  updateSettingsOrThrow: (
    updates: Partial<GlobalSettings>,
    onAcknowledged?: (settings: GlobalSettings) => void
  ) => Promise<void>
  setActiveRuntimeEnvironmentPreference: (environmentId: string | null) => Promise<boolean>
}

function normalizeRuntimeEnvironmentId(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

type SettingsWriteContext = {
  previousSettings: GlobalSettings | null
  visibilityOwnerHostId: ExecutionHostId
}

async function persistSettingsWrite(
  set: ownerHydration.SettingsStateSetter,
  get: () => AppState,
  updates: Partial<GlobalSettings>,
  onAcknowledged?: (settings: GlobalSettings) => void
): Promise<SettingsWriteContext> {
  const shouldPublish = ownerHydration.createSettingsPublicationFence(
    'activeRuntimeEnvironmentId' in updates || 'worktreeVisibilityDefaults' in updates
  )
  const context: SettingsWriteContext = {
    visibilityOwnerHostId: getSettingsFocusedExecutionHostId(get().settings),
    // Why capture: enabling an agent must re-probe its host, and the write is what says so.
    previousSettings: get().settings
  }
  await persistSettingsUpdates(
    set,
    updates,
    context.previousSettings,
    get().worktreeVisibilityDefaultsSupportedRuntimeEnvironmentId,
    get().worktreeVisibilitySourceDefaultsSupportedRuntimeEnvironmentId,
    shouldPublish,
    onAcknowledged
  )
  return context
}

async function refreshAfterSettingsWrite(
  get: () => AppState,
  updates: Partial<GlobalSettings>,
  context: SettingsWriteContext
): Promise<void> {
  // Why before the follow-up: the enable is about the write that just landed, and a follow-up
  // read that rejects must not swallow the re-detection it owes.
  if (enablesNewTuiAgents(context.previousSettings, get().settings)) {
    refreshDetectedAgentInventories(get())
  }
  if ('worktreeVisibilityDefaults' in updates) {
    await get().fetchAllWorktrees({ visibilityOwnerHostId: context.visibilityOwnerHostId })
  }
}

async function persistSettingsUpdates(
  set: ownerHydration.SettingsStateSetter,
  updates: Partial<GlobalSettings>,
  currentSettings: GlobalSettings | null,
  supportedRuntimeEnvironmentId: string | null,
  sourceDefaultsSupportedRuntimeEnvironmentId: string | null,
  shouldPublish: () => boolean,
  onAcknowledged?: (settings: GlobalSettings) => void
): Promise<void> {
  const normalizedUpdates = normalizeSettingsUpdates(updates, currentSettings)
  await persistVisibilityAwareSettings({
    normalizedUpdates,
    currentSettings,
    supportedRuntimeEnvironmentId,
    sourceDefaultsSupportedRuntimeEnvironmentId,
    shouldPublish,
    onAcknowledged,
    set
  })
}

/** Every known host has a recorded status entry, and no entry survives for a host that is gone. */
function hasCompleteRuntimeStatusCoverage(
  runtimeEnvironments: AppState['runtimeEnvironments'],
  runtimeStatusByEnvironmentId: AppState['runtimeStatusByEnvironmentId']
): boolean {
  return (
    new Set(runtimeEnvironments.map(({ id }) => id)).size === runtimeStatusByEnvironmentId.size &&
    runtimeEnvironments.every(({ id }) => runtimeStatusByEnvironmentId.has(id))
  )
}

async function verifyRuntimeEnvironmentReachable(environmentId: string | null): Promise<void> {
  if (!environmentId) {
    return
  }
  const response = await window.api.runtimeEnvironments.getStatus({
    selector: environmentId,
    timeoutMs: 15_000
  })
  const status = unwrapRuntimeRpcResult<RuntimeStatus>(response)
  assertRuntimeStatusCompatible(status)
  // Switch already proved compatibility; avoid the heavier generic RPC re-probe during hydration.
  markRuntimeEnvironmentCompatible(environmentId, status)
}

export const createSettingsSlice: StateCreator<AppState, [], [], SettingsSlice> = (set, get) => ({
  settings: null,
  settingsWriteFailureRevision: 0,
  worktreeVisibilityDefaultsByHost: {},
  worktreeVisibilityDefaultsSupportedRuntimeEnvironmentId: null,
  worktreeVisibilitySourceDefaultsSupportedRuntimeEnvironmentId: null,
  ...createSettingsSearchState((state) => set(state)),

  fetchSettings: async (options) => {
    await ownerHydration.fetchSettingsWithOwnerHydration({ options, set, get })
    const { runtimeEnvironmentCatalogHydrated, runtimeEnvironments, runtimeStatusByEnvironmentId } =
      get()
    // Probe all hosts only for incomplete/stale coverage; a recorded null still counts as checked.
    if (
      !runtimeEnvironmentCatalogHydrated ||
      !hasCompleteRuntimeStatusCoverage(runtimeEnvironments, runtimeStatusByEnvironmentId) ||
      // Why: coverage is blind to catalog edits from another client or the orca CLI.
      isRuntimeCatalogListingStale()
    ) {
      void get().hydrateRuntimeEnvironmentStatuses()
    }
  },

  awaitOwnerWorktreeVisibilityDefaultsHydration: () =>
    ownerHydration.awaitOwnerWorktreeVisibilityDefaultsHydration(get),

  updateSettings: async (updates) => {
    // Why before the write: a slow write can outlive a change of the focused host.
    const hostName = settingsWriteFailureHostName({
      updates,
      settings: get().settings,
      runtimeEnvironments: get().runtimeEnvironments
    })
    let context: SettingsWriteContext
    try {
      context = await persistSettingsWrite(set, get, updates)
    } catch (err) {
      handleSettingsWriteFailure({ error: err, hostName, set })
      return
    }
    try {
      await refreshAfterSettingsWrite(get, updates, context)
    } catch (err) {
      // Why: the setting saved, so reporting a failed save would be wrong.
      console.error('Failed to refresh after a settings update:', err)
    }
  },

  updateSettingsOrThrow: async (updates, onAcknowledged) => {
    const context = await persistSettingsWrite(set, get, updates, onAcknowledged)
    await refreshAfterSettingsWrite(get, updates, context)
  },

  setActiveRuntimeEnvironmentPreference: async (environmentId) => {
    const nextId = normalizeRuntimeEnvironmentId(environmentId)
    const previousId = normalizeRuntimeEnvironmentId(get().settings?.activeRuntimeEnvironmentId)
    if (previousId === nextId) {
      return true
    }
    const shouldPublish = ownerHydration.createSettingsPublicationFence(true)
    try {
      clearRuntimeCompatibilityCache(nextId)
      await verifyRuntimeEnvironmentReachable(nextId)
      if (!shouldPublish()) {
        return true
      }
      const nextSettings = await window.api.settings.setActiveRuntimeEnvironmentPreference({
        environmentId: nextId
      })
      bumpProviderRuntimeSessionGeneration()
      // Why: this is a focus change, so keep other host state while hydrating only the new owner's default.
      const focusedSettings =
        (nextSettings as GlobalSettings | undefined) ??
        (get().settings ? { ...get().settings!, activeRuntimeEnvironmentId: nextId } : null)
      if (focusedSettings) {
        const hydrated = await hydrateOwnerWorktreeVisibilityDefaults(
          focusedSettings,
          get().worktreeVisibilityDefaultsByHost
        )
        if (!shouldPublish()) {
          return true
        }
        set((state) => ({
          settings: hydrated.settings,
          worktreeVisibilityDefaultsByHost: {
            ...state.worktreeVisibilityDefaultsByHost,
            ...hydrated.defaultsByHost
          },
          worktreeVisibilityDefaultsSupportedRuntimeEnvironmentId:
            hydrated.supportedRuntimeEnvironmentId,
          worktreeVisibilitySourceDefaultsSupportedRuntimeEnvironmentId:
            hydrated.sourceDefaultsSupportedRuntimeEnvironmentId
        }))
      } else {
        set({ settings: null })
      }
      // Hydrate only the newly focused host’s catalog; downstream host merges preserve other hosts.
      await get().fetchRepos({ runtimeEnvironmentId: nextId })
      await get().fetchAllWorktrees()
      await get().fetchWorktreeLineage()
      await get().fetchBrowserSessionProfiles()
      return true
    } catch (err) {
      console.error('Failed to switch runtime environment:', err)
      toast.error(translate('auto.store.slices.settings.e12dab333b', 'Failed to switch servers'), {
        description: err instanceof Error ? err.message : String(err)
      })
      return false
    }
  }
})
