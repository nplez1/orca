import type { OrcaVmRecipe } from '../../shared/orca-yaml-hook-types'
import type {
  EphemeralVmRecipeStartFailure,
  EphemeralVmRecipeStartSuccess
} from '../../shared/ephemeral-vm-recipe-runner'
import {
  removeEphemeralVmProvisioningAttempt,
  upsertEphemeralVmProvisioningAttempt
} from '../../shared/ephemeral-vm-provisioning-attempts'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { recordSwallowedFailure } from '../observability/swallowed-failure'

/**
 * Starting one ephemeral runtime: the create hook, and the record that has to survive it.
 *
 * The create itself lives in `runtime-service`, on upstream's write-ahead records. What stays here is
 * the fork's own bookkeeping around it — the bounded attempts store its startup reconcile reads, and
 * the in-process in-flight registry that keeps that reconcile from flagging a live create.
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

export function beginEphemeralVmProvisioningInFlight(instanceId: string): void {
  inFlightCreates.add(instanceId)
}

/** Cleared for the whole create, not just the spawn: the row outlives the destroy hooks that follow. */
export function endEphemeralVmProvisioningInFlight(instanceId: string): void {
  inFlightCreates.delete(instanceId)
}

/**
 * Recorded before the spawn.
 *
 * Why: the recipe runs detached, so an app that is quit or killed during the create leaves the script
 * writing into a pipe nobody holds — and a machine the provider bills for with nothing on disk naming
 * it. The next startup looks for exactly these rows.
 */
export function recordEphemeralVmProvisioningAttempt(
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

/**
 * Best effort, deliberately.
 *
 * Why: a create that has succeeded must not be reported as an error because its bookkeeping row could
 * not be removed, and a spawn failure must not be replaced by a removal failure. A row that outlives
 * its create only costs a startup warning — and upstream's `provisioning` record remains the durable
 * one, so nothing is lost when this clears.
 */
export function forgetEphemeralVmProvisioningAttempt(
  userDataPath: string,
  instanceId: string
): void {
  try {
    removeEphemeralVmProvisioningAttempt(userDataPath, instanceId)
  } catch (error) {
    recordSwallowedFailure(
      'ephemeral-vm',
      error,
      `could not clear the provisioning record for ${instanceId}`
    )
  }
}
