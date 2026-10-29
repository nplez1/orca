import { randomUUID } from 'node:crypto'
import { assertEphemeralVmRuntimeCheckoutModeCanPersist } from '../../shared/ephemeral-vm-runtime-feature-store'
import { getEphemeralVmRecipeResultConnection } from '../../shared/ephemeral-vm-recipes'
import {
  listEphemeralVmRuntimes,
  removeEphemeralVmRuntime,
  upsertEphemeralVmRuntime
} from '../../shared/ephemeral-vm-runtime-store'
import { removeEphemeralVmProvisioningAttempt } from '../../shared/ephemeral-vm-provisioning-attempts'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import {
  toEphemeralVmRuntimeContextMenuFields,
  toEphemeralVmRuntimeExtendFields,
  toEphemeralVmRuntimeRecipeSnapshot
} from '../../shared/ephemeral-vm-runtimes'
import type {
  ProvisionEphemeralVmRuntimeArgs,
  ProvisionEphemeralVmRuntimeResult
} from './runtime-provisioning'
import { cleanupFailedEphemeralVmStart } from './failed-start-cleanup'

export type EphemeralVmCompatibilityPersistence = {
  instanceId: string
  createdAt: number
}

export function prepareEphemeralVmCompatibilityPersistence(
  args: ProvisionEphemeralVmRuntimeArgs
): EphemeralVmCompatibilityPersistence | null {
  if (!args.recipe.checkoutMode) {
    return null
  }
  listEphemeralVmRuntimes(args.userDataPath)
  const compatibility = {
    instanceId: `orca-${randomUUID()}`,
    createdAt: args.now ?? Date.now()
  }
  assertEphemeralVmRuntimeCheckoutModeCanPersist(args.userDataPath, {
    id: compatibility.instanceId,
    recipeId: args.recipe.id,
    createdAt: compatibility.createdAt,
    checkoutMode: args.recipe.checkoutMode
  })
  return compatibility
}

export async function persistProvisionedEphemeralVmRuntime(
  args: ProvisionEphemeralVmRuntimeArgs,
  start: Extract<ProvisionEphemeralVmRuntimeResult, { ok: true }>['start'],
  compatibility: EphemeralVmCompatibilityPersistence | null
): Promise<EphemeralVmRuntimeRecord> {
  const now = compatibility?.createdAt ?? args.now ?? Date.now()
  const connection = getEphemeralVmRecipeResultConnection(start.result)
  try {
    return upsertEphemeralVmRuntime(args.userDataPath, {
      id: start.context.instanceId ?? start.context.recipeId,
      recipeId: args.recipe.id,
      recipe: toEphemeralVmRuntimeRecipeSnapshot(args.recipe),
      // Why snapshotted beside the recipe: the lease this host was created under must stay
      // extendable by the recipe that bought it, even if orca.yaml changes or drops it later.
      ...toEphemeralVmRuntimeExtendFields(args.recipe),
      // Same reason: a menu item an existing host's recipe declared must keep pointing at the
      // script it was approved with, not at whatever repo it later resolves to.
      ...toEphemeralVmRuntimeContextMenuFields(args.recipe),
      ...(args.repoId ? { repoId: args.repoId } : {}),
      ...(args.projectId ? { projectId: args.projectId } : {}),
      ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
      ...(args.workspaceName ? { workspaceName: args.workspaceName } : {}),
      status: 'running',
      connectionMode: connection.type,
      cleanupStatus: args.recipe.destroyDisabled ? 'disabled' : 'not_started',
      ...(args.recipe.destroyDisabled ? { cleanupDisabled: true } : {}),
      createdAt: now,
      updatedAt: now,
      recipeResult: start.result
    })
  } catch (error) {
    if (compatibility) {
      const cleaned = await cleanupFailedEphemeralVmStart(args, {
        context: start.context,
        recipeResult: start.result
      })
      if (
        cleaned &&
        listEphemeralVmRuntimes(args.userDataPath).some(
          (runtime) => runtime.id === compatibility.instanceId
        )
      ) {
        removeEphemeralVmRuntime(args.userDataPath, compatibility.instanceId)
      }
      // Why the provisioning row goes with a successful destroy: that is the one case where nothing was
      // left behind, and the row exists only to say otherwise. A failed destroy keeps it, along with the
      // `cleanup_failed` record above it.
      if (cleaned) {
        removeEphemeralVmProvisioningAttempt(
          args.userDataPath,
          start.context.instanceId ?? compatibility.instanceId
        )
      }
    }
    throw error
  }
}
