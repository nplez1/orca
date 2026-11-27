import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import type { PluginService } from '../../plugins/plugin-service'
import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'
import { startEphemeralVmRuntimeReclaim } from '../../ephemeral-vm-runtime-reclaim'
import { flagInterruptedEphemeralVmProvisioning } from '../../ephemeral-vm-runtime-provisioning-recovery'
import { getCurrentMainWindow } from '../ssh/ssh-ipc-context'

const EPHEMERAL_VM_STORE_FILES = [
  'orca-ephemeral-vm-runtimes.json',
  'orca-ephemeral-vm-runtimes-write-ahead.json'
] as const

export const EPHEMERAL_VM_IPC_CHANNELS = [
  'ephemeralVm:listRecipes',
  'ephemeralVm:listRecipeCatalog',
  'ephemeralVm:doctor',
  'ephemeralVm:provision',
  'ephemeralVm:cancelProvision',
  'ephemeralVm:publishPendingCheckouts',
  'ephemeralVm:listPendingCheckouts',
  'ephemeralVm:listCredentialEnvNames',
  'ephemeralVm:listRuntimes',
  'ephemeralVm:attachWorkspace',
  'ephemeralVm:cleanup',
  'ephemeralVm:stopCleanup',
  'ephemeralVm:forgetRuntime',
  'ephemeralVm:getCleanupCommand',
  'ephemeralVm:extendLifetime',
  'ephemeralVm:runContextMenuItem'
] as const

async function hasPersistedEphemeralVmState(userDataPath: string): Promise<boolean> {
  const checks = await Promise.all(
    EPHEMERAL_VM_STORE_FILES.map((file) =>
      access(join(userDataPath, file)).then(
        () => true,
        () => false
      )
    )
  )
  return checks.some(Boolean)
}

export function registerLazyEphemeralVmHandlers(store: Store, pluginService?: PluginService): void {
  let startupReconciled = false
  const reconcileOnce = async (): Promise<void> => {
    if (startupReconciled) {
      return
    }
    startupReconciled = true
    const { reconcileInterruptedEphemeralVmProvisionsOnStartup } =
      await import('../../ephemeral-vm/runtime-provisioning-persistence')
    reconcileInterruptedEphemeralVmProvisionsOnStartup(app.getPath('userData'))
  }

  registerLazyIpcHandleGroup(EPHEMERAL_VM_IPC_CHANNELS, async (ipc) => {
    const { registerEphemeralVmHandlers } = await import('./ephemeral-vm')
    registerEphemeralVmHandlers(store, pluginService, ipc, {
      skipStartupReconcile: startupReconciled
    })
    startupReconciled = true
  })

  // The fork's own duties run at startup, outside the group above: the group loads on the first
  // `ephemeralVm:*` call, and both duties are about state the previous session left behind, so the
  // session that never opens the VM UI is exactly the one that must still run them.
  runForkEphemeralVmStartupDuties(app.getPath('userData'))

  // Only load ephemeral-VM reconciliation at startup if persisted VM state files exist on disk.
  void hasPersistedEphemeralVmState(app.getPath('userData'))
    .then((exists) => (exists ? reconcileOnce() : undefined))
    .catch(() => {})
}

/**
 * The sweep that reclaims lapsed leases and the flag for creates that never reported.
 *
 * Why once, here: `startEphemeralVmRuntimeReclaim` is idempotent across registrations (it adopts the new
 * context rather than arming a second interval), and both calls used to sit in the eagerly registered
 * handler module before the group became lazy.
 */
function runForkEphemeralVmStartupDuties(userDataPath: string): void {
  startEphemeralVmRuntimeReclaim({ userDataPath, getMainWindow: getCurrentMainWindow })
  // Why here: a create runs detached, so this is the only point at which an attempt that never
  // reported can be told apart from one whose app was killed mid-flight. It warns and records the
  // flag; nothing can destroy the machine, because no recipe result ever arrived to build destroy from.
  flagInterruptedEphemeralVmProvisioning({ userDataPath })
}
