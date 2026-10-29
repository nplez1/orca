import type { OrcaVmRecipe } from '../../shared/orca-yaml-hook-types'
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
    // Why cleared on a rejection: the hook never reported, and a failure to spawn it means it never
    // ran either, so there is no machine for a later startup to look for.
    removeEphemeralVmProvisioningAttempt(args.userDataPath, instanceId)
    throw error
  }
  if (!start.ok) {
    // A reported failure is not an orphan: whatever the machine's state, the transcript is in front of
    // the user. A create that allocated and then failed is covered by the cleanup hook below.
    removeEphemeralVmProvisioningAttempt(args.userDataPath, instanceId)
    if (start.recipeResult) {
      await cleanupFailedEphemeralVmStart(args, {
        context: start.context,
        recipeResult: start.recipeResult
      })
    }
    return { ok: false, start }
  }

  // Why the attempt outlives the persist: the persisted record is what replaces it, so clearing first
  // would leave a window where a crash loses both.
  const runtime = await persistProvisionedEphemeralVmRuntime(args, start, compatibility)
  removeEphemeralVmProvisioningAttempt(args.userDataPath, instanceId)

  return { ok: true, start, runtime }
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
