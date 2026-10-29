import {
  flagEphemeralVmProvisioningAttemptInterrupted,
  listEphemeralVmProvisioningAttempts,
  removeEphemeralVmProvisioningAttempt,
  type EphemeralVmProvisioningAttempt
} from '../shared/ephemeral-vm-provisioning-attempts'
import { listEphemeralVmRuntimes } from '../shared/ephemeral-vm-runtime-store'

/**
 * Which creates never reported, so a machine the provider may be billing for is not forgotten.
 *
 * Why startup is the only place this can run: a create is a detached process. When the app is quit or
 * killed during it the hook finishes into a pipe nobody holds, so nothing in the running app can ever
 * learn the outcome — the durable attempt is the only evidence, and it is read here.
 *
 * Why the attempt is flagged rather than cleaned up: Orca cannot destroy the machine. A destroy payload
 * is built from the recipe result, and the whole point of an interrupted create is that no result was
 * ever received — so inventing one would send a provider a request about a resource id nobody knows.
 * The flag is the honest record: it names the recipe, the repo and the workspace the machine was bought
 * for, and it stays until a create reports under the same instance id.
 */
export function flagInterruptedEphemeralVmProvisioning(args: {
  userDataPath: string
  /** Injected by tests; production reads the wall clock. */
  now?: number
}): EphemeralVmProvisioningAttempt[] {
  const attempts = listEphemeralVmProvisioningAttempts(args.userDataPath)
  if (attempts.length === 0) {
    return []
  }
  const runtimeIds = new Set(listEphemeralVmRuntimes(args.userDataPath).map((entry) => entry.id))
  const interrupted: EphemeralVmProvisioningAttempt[] = []
  for (const attempt of attempts) {
    if (runtimeIds.has(attempt.instanceId)) {
      // Why dropped silently: the create did report. The app died between persisting the runtime and
      // clearing this row, so the host is already tracked and nothing is at risk.
      removeEphemeralVmProvisioningAttempt(args.userDataPath, attempt.instanceId)
      continue
    }
    const flagged = flagEphemeralVmProvisioningAttemptInterrupted(
      args.userDataPath,
      attempt.instanceId,
      args.now ?? Date.now()
    )
    if (flagged) {
      interrupted.push(flagged)
      // Why only the first time: registration re-runs on macOS re-activation, and a warning repeated
      // every time a window opens is a warning nobody reads.
      if (attempt.interruptedAt === undefined) {
        warnInterruptedProvisioning(flagged)
      }
    }
  }
  return interrupted
}

function warnInterruptedProvisioning(attempt: EphemeralVmProvisioningAttempt): void {
  const workspace = attempt.workspaceName ? ` for workspace "${attempt.workspaceName}"` : ''
  console.warn(
    `[ephemeral-vm] A create for recipe "${attempt.recipeId}"${workspace} never reported (instance ${attempt.instanceId}, started ${new Date(attempt.startedAt).toISOString()}). ` +
      'The machine may still be running and Orca holds no recipe result for it, so it cannot destroy it — check the provider and delete it by hand.'
  )
}
