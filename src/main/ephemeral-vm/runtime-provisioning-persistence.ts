import { randomUUID } from 'node:crypto'
import { assertEphemeralVmRuntimeCheckoutModeCanPersist } from '../../shared/ephemeral-vm-runtime-feature-store'
import { getEphemeralVmRecipeResultConnection } from '../../shared/ephemeral-vm-recipes'
import {
  listEphemeralVmRuntimes,
  removeEphemeralVmRuntime,
  updateEphemeralVmRuntimeStatus,
  upsertEphemeralVmRuntime
} from '../../shared/ephemeral-vm-runtime-store'
import { removeEphemeralVmProvisioningAttempt } from '../../shared/ephemeral-vm-provisioning-attempts'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import {
  ephemeralVmFailure,
  ephemeralVmFailureFromError,
  pickEphemeralVmFailureCode,
  type EphemeralVmFailure
} from '../../shared/ephemeral-vm-failure-copy'
import type { EphemeralVmRecipeStartFailure } from '../../shared/ephemeral-vm-recipe-runner'
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

/** The fork's provisioning path still keys its records through this; upstream's write-ahead
 *  flow below carries the same identity plus its `launched` flag. */
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

export type EphemeralVmWriteAhead = {
  instanceId: string
  createdAt: number
  /** Set once the create command's process started; before that no VM can exist. */
  launched: boolean
}

// Creates owned by this process; any other `provisioning` record was orphaned by a crash or quit.
const liveProvisionInstanceIds = new Set<string>()

export function isEphemeralVmProvisionLive(instanceId: string): boolean {
  return liveProvisionInstanceIds.has(instanceId)
}

/** Persist the `provisioning` record before spawning create so a crash cannot leak an untracked VM. */
export function beginEphemeralVmProvisioning(
  args: ProvisionEphemeralVmRuntimeArgs
): EphemeralVmWriteAhead {
  const writeAhead: EphemeralVmWriteAhead = {
    instanceId: `orca-${randomUUID()}`,
    createdAt: args.now ?? Date.now(),
    launched: false
  }
  if (args.recipe.checkoutMode) {
    assertEphemeralVmRuntimeCheckoutModeCanPersist(args.userDataPath, {
      id: writeAhead.instanceId,
      recipeId: args.recipe.id,
      createdAt: writeAhead.createdAt,
      checkoutMode: args.recipe.checkoutMode
    })
  }
  upsertEphemeralVmRuntime(args.userDataPath, {
    ...baseRuntimeRecord(args, writeAhead),
    status: 'provisioning',
    updatedAt: writeAhead.createdAt
  })
  liveProvisionInstanceIds.add(writeAhead.instanceId)
  return writeAhead
}

export function endEphemeralVmProvisioning(
  args: ProvisionEphemeralVmRuntimeArgs,
  writeAhead: EphemeralVmWriteAhead,
  error?: unknown
): void {
  liveProvisionInstanceIds.delete(writeAhead.instanceId)
  if (error === undefined) {
    return
  }
  try {
    const record = findRuntime(args.userDataPath, writeAhead.instanceId)
    if (record?.status === 'provisioning' && !writeAhead.launched) {
      removeEphemeralVmRuntime(args.userDataPath, record.id)
    } else if (record?.status === 'provisioning') {
      markProvisionFailed(args.userDataPath, record.id, ephemeralVmFailureFromError(error))
    }
  } catch {
    // Why: surface the original provisioning error; startup reconciliation retries the flip.
  }
}

export async function persistFailedEphemeralVmStart(
  args: ProvisionEphemeralVmRuntimeArgs,
  writeAhead: EphemeralVmWriteAhead,
  start: EphemeralVmRecipeStartFailure
): Promise<void> {
  if (!start.recipeResult && !writeAhead.launched) {
    // Why: create never ran (validation failed or it was cancelled first), so no VM can exist.
    removeIfPresent(args.userDataPath, writeAhead.instanceId)
    return
  }
  if (!start.recipeResult) {
    // Why: create may have allocated resources before failing; keep the row so the user can destroy it.
    markProvisionFailed(args.userDataPath, writeAhead.instanceId, {
      error: start.error,
      ...pickEphemeralVmFailureCode(start)
    })
    return
  }
  const cleaned = await cleanupFailedEphemeralVmStart(args, {
    context: start.context,
    recipeResult: start.recipeResult,
    createdAt: writeAhead.createdAt
  })
  if (cleaned) {
    removeIfPresent(args.userDataPath, writeAhead.instanceId)
  }
}

export async function persistProvisionedEphemeralVmRuntime(
  args: ProvisionEphemeralVmRuntimeArgs,
  start: Extract<ProvisionEphemeralVmRuntimeResult, { ok: true }>['start'],
  provided: EphemeralVmWriteAhead | EphemeralVmCompatibilityPersistence | null
): Promise<EphemeralVmRuntimeRecord> {
  const identity: EphemeralVmCompatibilityPersistence = provided ?? {
    instanceId: start.context.instanceId ?? start.context.recipeId,
    createdAt: args.now ?? Date.now()
  }
  const connection = getEphemeralVmRecipeResultConnection(start.result)
  try {
    return upsertEphemeralVmRuntime(args.userDataPath, {
      ...baseRuntimeRecord(args, identity),
      status: 'running',
      connectionMode: connection.type,
      updatedAt: args.now ?? Date.now(),
      recipeResult: start.result
    })
  } catch (error) {
    if (args.recipe.checkoutMode) {
      const cleaned = await cleanupFailedEphemeralVmStart(args, {
        context: start.context,
        recipeResult: start.result,
        createdAt: identity.createdAt
      })
      if (cleaned) {
        removeIfPresent(args.userDataPath, identity.instanceId)
        // Why the provisioning row goes with a successful destroy: that is the one case where nothing was
        // left behind, and the row exists only to say otherwise. A failed destroy keeps it, along with the
        // `cleanup_failed` record above it.
        try {
          removeEphemeralVmProvisioningAttempt(
            args.userDataPath,
            start.context.instanceId ?? identity.instanceId
          )
        } catch {
          // Why swallowed: this whole path runs because a write just failed, often for the same disk
          // reason, and replacing the persistence error with a bookkeeping one would report the wrong
          // failure. The machine was destroyed, so a leftover row only costs a startup warning.
        }
      }
    }
    throw error
  }
}

/** Flip `provisioning` records with no live create in this process to `failed` so Settings offers Destroy. */
export function reconcileInterruptedEphemeralVmProvisions(
  userDataPath: string,
  now = Date.now()
): EphemeralVmRuntimeRecord[] {
  return listEphemeralVmRuntimes(userDataPath)
    .filter(
      (runtime) => runtime.status === 'provisioning' && !isEphemeralVmProvisionLive(runtime.id)
    )
    .map((runtime) =>
      markProvisionFailed(userDataPath, runtime.id, ephemeralVmFailure('provisionInterrupted'), now)
    )
}

export function reconcileInterruptedEphemeralVmProvisionsOnStartup(userDataPath: string): void {
  try {
    reconcileInterruptedEphemeralVmProvisions(userDataPath)
  } catch (error) {
    console.warn('[ephemeral-vm] Could not reconcile interrupted provisions:', error)
  }
}

/** Tracked VMs must go through Destroy; only result-less write-ahead rows can be dropped by hand. */
export function forgetInterruptedEphemeralVmProvision(
  userDataPath: string,
  runtimeId: string
): void {
  const runtime = findRuntime(userDataPath, runtimeId)
  if (!runtime) {
    return
  }
  if (
    runtime.recipeResult ||
    runtime.status === 'cleanup_pending' ||
    (runtime.status === 'provisioning' && isEphemeralVmProvisionLive(runtime.id))
  ) {
    throw new Error(`Ephemeral VM runtime must be destroyed, not removed: ${runtimeId}`)
  }
  removeEphemeralVmRuntime(userDataPath, runtimeId)
}

function markProvisionFailed(
  userDataPath: string,
  runtimeId: string,
  failure: EphemeralVmFailure,
  now = Date.now()
): EphemeralVmRuntimeRecord {
  // cleanupLastError is the row's displayed error, which older builds also render.
  return updateEphemeralVmRuntimeStatus(userDataPath, runtimeId, {
    status: 'failed',
    cleanupLastError: failure,
    updatedAt: now
  })
}

function baseRuntimeRecord(
  args: ProvisionEphemeralVmRuntimeArgs,
  identity: EphemeralVmWriteAhead | EphemeralVmCompatibilityPersistence
): Omit<EphemeralVmRuntimeRecord, 'status' | 'updatedAt'> {
  return {
    id: identity.instanceId,
    recipeId: args.recipe.id,
    recipe: toEphemeralVmRuntimeRecipeSnapshot(args.recipe),
    // Why snapshotted beside the recipe: the lease this host was created under must stay
    // extendable by the recipe that bought it, even if orca.yaml changes or drops it later.
    ...toEphemeralVmRuntimeExtendFields(args.recipe),
    // Same reason: a menu item an existing host's recipe declared must keep pointing at the
    // script it was approved with, not at whatever repo it later resolves to.
    ...toEphemeralVmRuntimeContextMenuFields(args.recipe),
    ...(args.repoId ? { repoId: args.repoId } : {}),
    ...(args.repoPath ? { repoPath: args.repoPath } : {}),
    ...(args.projectId ? { projectId: args.projectId } : {}),
    ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
    ...(args.workspaceName ? { workspaceName: args.workspaceName } : {}),
    cleanupStatus: args.recipe.destroyDisabled ? 'disabled' : 'not_started',
    ...(args.recipe.destroyDisabled ? { cleanupDisabled: true } : {}),
    createdAt: identity.createdAt
  }
}

function findRuntime(userDataPath: string, id: string): EphemeralVmRuntimeRecord | undefined {
  return listEphemeralVmRuntimes(userDataPath).find((runtime) => runtime.id === id)
}

function removeIfPresent(userDataPath: string, id: string): void {
  if (findRuntime(userDataPath, id)) {
    removeEphemeralVmRuntime(userDataPath, id)
  }
}
