import { app, ipcMain } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import type { EphemeralVmRecipeDoctorResult } from '../../../shared/remote-runtime/ephemeral-vm-recipes/ephemeral-vm-recipes'
// Import the Node-only doctor directly so browser consumers of the barrel do not bundle fs/path.
import { doctorEphemeralVmRecipe } from '../../../shared/remote-runtime/ephemeral-vm-recipes/ephemeral-vm-recipe-doctor'
import { reconcileInterruptedEphemeralVmProvisionsOnStartup } from '../../ephemeral-vm/runtime-provisioning-persistence'
import {
  getRecipeRepo,
  listRecipeCatalog,
  listRecipes,
  type EphemeralVmRecipeCatalogEntry
} from './ephemeral-vm-recipe-context'
import { registerEphemeralVmRuntimeHandlers } from './ephemeral-vm-runtime-handlers'
import type { PluginService } from '../../plugins/plugin-service'
import { getApprovedPluginVmRecipes } from '../../plugins/contributions/plugin-approved-vm-recipes'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import { startEphemeralVmRuntimeReclaim } from '../../ephemeral-vm-runtime-reclaim'
import { flagInterruptedEphemeralVmProvisioning } from '../../ephemeral-vm-runtime-provisioning-recovery'
import { getCurrentMainWindow } from '../ssh/ssh-ipc-context'
import {
  cancelEphemeralVmProvision,
  handleEphemeralVmProvision,
  type EphemeralVmProvisionIpcArgs,
  type EphemeralVmProvisionIpcResult
} from './ephemeral-vm-provision-handler'

export type { EphemeralVmProvisionIpcResult } from './ephemeral-vm-provision-handler'

export function registerEphemeralVmHandlers(
  store: Store,
  pluginService?: PluginService,
  ipc: IpcHandleRegistrar = ipcMain,
  options?: { skipStartupReconcile?: boolean }
): void {
  if (ipc === ipcMain) {
    for (const ch of [
      'listRecipes',
      'listRecipeCatalog',
      'doctor',
      'provision',
      'cancelProvision'
    ]) {
      ipcMain.removeHandler(`ephemeralVm:${ch}`)
    }
  }
  registerEphemeralVmRuntimeHandlers(store, ipc)
  startEphemeralVmRuntimeReclaim({
    userDataPath: app.getPath('userData'),
    getMainWindow: getCurrentMainWindow
  })
  // Why here: a create runs detached, so this is the only point at which an attempt that never
  // reported can be told apart from one whose app was killed mid-flight. It warns and records the
  // flag; nothing can destroy the machine, because no recipe result ever arrived to build destroy from.
  flagInterruptedEphemeralVmProvisioning({ userDataPath: app.getPath('userData') })
  if (!options?.skipStartupReconcile) {
    reconcileInterruptedEphemeralVmProvisionsOnStartup(app.getPath('userData'))
  }

  ipc.handle('ephemeralVm:listRecipes', async (_event, args: { repoId: string }) => {
    return listRecipes(store, args.repoId, await getApprovedPluginVmRecipes(pluginService))
  })

  ipc.handle(
    'ephemeralVm:listRecipeCatalog',
    async (): Promise<EphemeralVmRecipeCatalogEntry[]> => {
      return listRecipeCatalog(store, await getApprovedPluginVmRecipes(pluginService))
    }
  )

  ipc.handle(
    'ephemeralVm:doctor',
    async (
      _event,
      args: { repoId: string; recipeId: string }
    ): Promise<EphemeralVmRecipeDoctorResult> => {
      const repo = getRecipeRepo(store, args.repoId)
      if (!repo.ok) {
        return repo.doctor(args.recipeId)
      }
      const pluginRecipes = await getApprovedPluginVmRecipes(pluginService)
      return doctorEphemeralVmRecipe({
        repoPath: repo.repo.path,
        recipeId: args.recipeId,
        recipes: listRecipes(store, args.repoId, pluginRecipes).recipes,
        localExecutionSupported: true
      })
    }
  )

  ipc.handle(
    'ephemeralVm:provision',
    (event, args: EphemeralVmProvisionIpcArgs): Promise<EphemeralVmProvisionIpcResult> =>
      handleEphemeralVmProvision(event, args, store, pluginService)
  )

  ipc.handle(
    'ephemeralVm:cancelProvision',
    (_event, args: { provisionId: string }): { cancelled: boolean } =>
      cancelEphemeralVmProvision(args.provisionId)
  )
}
