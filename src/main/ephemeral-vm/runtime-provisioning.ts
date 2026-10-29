import type { OrcaVmRecipe } from '../../shared/orca-yaml-hook-types'
import { errorMessage } from '../../shared/error-message'
import {
  newEphemeralVmInstanceId,
  runEphemeralVmRecipeStart,
  type EphemeralVmRecipeStartFailure,
  type EphemeralVmRecipeStartResult,
  type EphemeralVmRecipeStartSuccess
} from '../../shared/ephemeral-vm-recipe-runner'
import {
  removeEphemeralVmProvisioningAttempt,
  upsertEphemeralVmProvisioningAttempt
} from '../../shared/ephemeral-vm-provisioning-attempts'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { cleanupFailedEphemeralVmStart } from './failed-start-cleanup'
import {
  persistProvisionedEphemeralVmRuntime,
  prepareEphemeralVmCompatibilityPersistence
} from './runtime-provisioning-persistence'

/**
 * Starting one ephemeral runtime: the create hook, and the record that has to survive it.
 *
 * Split from `runtime-service` because it is the only lifecycle action that runs a hook before any
 * record of the machine exists, so the ordering inside it is what the leak fixes are about.
 */

export type ProvisionEphemeralVmRuntimeArgs = {
  userDataPath: string
  repoPath: string
  recipe: OrcaVmRecipe
  repoId?: string
  projectId?: string
  workspaceId?: string
  workspaceName?: string
  repoUrl?: string
  branch?: string
  ref?: string
  expectedRefHead?: string
  orcaVersion?: string
  now?: number
  signal?: AbortSignal
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

export type ProvisionEphemeralVmRuntimeResult =
  | {
      ok: true
      start: EphemeralVmRecipeStartSuccess
      runtime: EphemeralVmRuntimeRecord
    }
  | {
      ok: false
      start: EphemeralVmRecipeStartFailure
    }

/**
 * Instance ids whose create is running in this process.
 *
 * Why: handler registration re-runs on macOS re-activation, and the startup reconcile would otherwise
 * flag a create that is still in flight as one that never reported.
 */
const inFlightCreates = new Set<string>()

/** Whether a create for this instance id is still running here, for the startup reconcile to skip. */
export function isEphemeralVmProvisioningInFlight(instanceId: string): boolean {
  return inFlightCreates.has(instanceId)
}

/**
 * Test seam: the reconcile has to be shown an in-flight create without running a real one.
 *
 * Why it exists rather than a public setter: only the reconcile's question is public, and the ids belong
 * to creates this module owns.
 */
export function holdEphemeralVmProvisioningInFlightForTest(instanceId: string): () => void {
  inFlightCreates.add(instanceId)
  return () => {
    inFlightCreates.delete(instanceId)
  }
}

export async function provisionEphemeralVmRuntime(
  args: ProvisionEphemeralVmRuntimeArgs
): Promise<ProvisionEphemeralVmRuntimeResult> {
  const compatibility = prepareEphemeralVmCompatibilityPersistence(args)
  // Why the id is chosen here rather than inside the runner: it has to exist before the hook starts,
  // because the hook is what allocates the machine.
  const instanceId = compatibility?.instanceId ?? newEphemeralVmInstanceId()
  // Why recorded before the spawn: the recipe runs detached, so an app that is quit or killed during
  // the create leaves the script writing into a pipe nobody holds — and a machine the provider bills
  // for with nothing on disk naming it. The next startup looks for exactly these rows.
  recordProvisioningAttempt(args, instanceId, compatibility?.createdAt)

  inFlightCreates.add(instanceId)
  let start: EphemeralVmRecipeStartResult
  try {
    start = await runEphemeralVmRecipeStart({
      repoPath: args.repoPath,
      recipe: args.recipe,
      context: {
        instanceId,
        projectId: args.projectId,
        workspaceId: args.workspaceId,
        workspaceName: args.workspaceName,
        repoUrl: args.repoUrl,
        branch: args.branch,
        ref: args.ref,
        expectedRefHead: args.expectedRefHead,
        orcaVersion: args.orcaVersion
      },
      signal: args.signal,
      onStdout: args.onStdout,
      onStderr: args.onStderr
    })
  } catch (error) {
    inFlightCreates.delete(instanceId)
    // Why cleared on a rejection: the hook never reported, and a failure to spawn it means it never
    // ran either, so there is no machine for a later startup to look for.
    forgetProvisioningAttempt(args.userDataPath, instanceId)
    throw error
  }
  inFlightCreates.delete(instanceId)

  if (!start.ok) {
    return finishFailedProvisioning(args, { instanceId, start })
  }

  let runtime: EphemeralVmRuntimeRecord
  try {
    // Why the attempt outlives the persist: the persisted record is what replaces it, so clearing first
    // would leave a window where a crash loses both.
    runtime = await persistProvisionedEphemeralVmRuntime(args, start, compatibility)
  } catch (error) {
    // Why cleared for a compatibility recipe only: that persistence path destroys the machine before
    // rethrowing, so nothing is left to find. Otherwise the machine exists and only this row names it.
    if (compatibility) {
      forgetProvisioningAttempt(args.userDataPath, instanceId)
    }
    throw error
  }
  forgetProvisioningAttempt(args.userDataPath, instanceId)

  return { ok: true, start, runtime }
}

/**
 * The machine's fate after a create that reported a failure.
 *
 * Why the attempt sometimes stays: a hook that was killed never showed anyone its transcript, and the
 * release it may have run lives inside the recipe — so a machine can exist with nothing recording it.
 * A hook that exited on its own put its reason in front of the user, which is a record they can act on.
 */
async function finishFailedProvisioning(
  args: ProvisionEphemeralVmRuntimeArgs,
  failed: { instanceId: string; start: EphemeralVmRecipeStartFailure }
): Promise<ProvisionEphemeralVmRuntimeResult> {
  if (!failed.start.recipeResult) {
    if (!failed.start.aborted) {
      forgetProvisioningAttempt(args.userDataPath, failed.instanceId)
    }
    return { ok: false, start: failed.start }
  }
  try {
    // Why cleanup before the row is cleared: a kill during this destroy hook would leave a machine whose
    // id Orca knows with no record of it, which is exactly the leak this row exists to prevent.
    await cleanupFailedEphemeralVmStart(args, {
      context: failed.start.context,
      recipeResult: failed.start.recipeResult
    })
  } catch {
    // Why keep the row: cleanupFailedEphemeralVmStart throws when it could not even record the failure,
    // so the machine's state is unknown and this row is the only thing that says it may exist.
    return { ok: false, start: failed.start }
  }
  forgetProvisioningAttempt(args.userDataPath, failed.instanceId)
  return { ok: false, start: failed.start }
}

/**
 * Best effort, deliberately.
 *
 * Why: a create that has succeeded must not be reported as an error because its bookkeeping row could
 * not be removed, and a spawn failure must not be replaced by a removal failure. A row that outlives
 * its create only costs a startup warning.
 */
function forgetProvisioningAttempt(userDataPath: string, instanceId: string): void {
  try {
    removeEphemeralVmProvisioningAttempt(userDataPath, instanceId)
  } catch (error) {
    console.warn(
      `[ephemeral-vm] Could not clear the provisioning record for ${instanceId}: ${errorMessage(error)}`
    )
  }
}

function recordProvisioningAttempt(
  args: ProvisionEphemeralVmRuntimeArgs,
  instanceId: string,
  createdAt: number | undefined
): void {
  upsertEphemeralVmProvisioningAttempt(args.userDataPath, {
    instanceId,
    recipeId: args.recipe.id,
    repoPath: args.repoPath,
    startedAt: createdAt ?? args.now ?? Date.now(),
    ...(args.repoId ? { repoId: args.repoId } : {}),
    ...(args.projectId ? { projectId: args.projectId } : {}),
    ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
    ...(args.workspaceName ? { workspaceName: args.workspaceName } : {})
  })
}
