import { errorMessage } from '../shared/error-message'
import {
  flagEphemeralVmProvisioningAttemptInterrupted,
  listEphemeralVmProvisioningAttempts,
  removeEphemeralVmProvisioningAttempt,
  type EphemeralVmProvisioningAttempt
} from '../shared/ephemeral-vm-provisioning-attempts'
import { listEphemeralVmRuntimes } from '../shared/ephemeral-vm-runtime-store'
import { isEphemeralVmProvisioningInFlight } from './ephemeral-vm/runtime-provisioning'

/**
 * How many interrupted creates are kept.
 *
 * Why bounded: a resolved attempt can never be matched by a later create — every create gets a fresh
 * instance id — so an interrupted row only leaves when an operator deals with it. Unbounded growth would
 * eventually push the store past its read limit, which is the one failure that would lose the record
 * silently, so the newest rows win and each drop is reported.
 */
export const MAX_INTERRUPTED_EPHEMERAL_VM_PROVISIONING_ATTEMPTS = 20

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
 * The flag names the recipe, the repo and the workspace the machine was bought for, and it stays until
 * an operator has dealt with it.
 *
 * Why nothing escapes from here: this runs while IPC handlers are being registered, so a read or write
 * failure would leave every channel registered after it unregistered — a much larger outage than the
 * warning it was trying to emit.
 */
export function flagInterruptedEphemeralVmProvisioning(args: {
  userDataPath: string
  /** Injected by tests; production reads the wall clock. */
  now?: number
}): EphemeralVmProvisioningAttempt[] {
  try {
    return reconcileInterruptedProvisioning(args)
  } catch (error) {
    console.warn(
      `[ephemeral-vm] Could not check for creates that never reported: ${errorMessage(error)}`
    )
    return []
  }
}

function reconcileInterruptedProvisioning(args: {
  userDataPath: string
  now?: number
}): EphemeralVmProvisioningAttempt[] {
  const attempts = listEphemeralVmProvisioningAttempts(args.userDataPath)
  if (attempts.length === 0) {
    return []
  }
  const runtimeIds = new Set(listEphemeralVmRuntimes(args.userDataPath).map((entry) => entry.id))
  const interrupted: EphemeralVmProvisioningAttempt[] = []
  for (const attempt of attempts) {
    // Why: handler registration re-runs on macOS re-activation, and a create started from the previous
    // window is still running in this process. Flagging it would tell the user to delete a machine that
    // is about to be recorded.
    if (isEphemeralVmProvisioningInFlight(attempt.instanceId)) {
      continue
    }
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
      // Why only the first time: a warning repeated on every window that opens is a warning nobody reads.
      if (attempt.interruptedAt === undefined) {
        warnInterruptedProvisioning(flagged)
      }
    }
  }
  return pruneInterruptedProvisioning(args.userDataPath, interrupted)
}

function pruneInterruptedProvisioning(
  userDataPath: string,
  interrupted: EphemeralVmProvisioningAttempt[]
): EphemeralVmProvisioningAttempt[] {
  if (interrupted.length <= MAX_INTERRUPTED_EPHEMERAL_VM_PROVISIONING_ATTEMPTS) {
    return interrupted
  }
  const retained = [...interrupted]
    .sort((left, right) => (right.interruptedAt ?? 0) - (left.interruptedAt ?? 0))
    .slice(0, MAX_INTERRUPTED_EPHEMERAL_VM_PROVISIONING_ATTEMPTS)
  const retainedIds = new Set(retained.map((attempt) => attempt.instanceId))
  for (const dropped of interrupted.filter((attempt) => !retainedIds.has(attempt.instanceId))) {
    removeEphemeralVmProvisioningAttempt(userDataPath, dropped.instanceId)
    console.warn(
      `[ephemeral-vm] Dropped the oldest record of an interrupted create (instance ${dropped.instanceId}, recipe "${dropped.recipeId}") to keep the store readable. That machine still needs checking with the provider.`
    )
  }
  return retained
}

function warnInterruptedProvisioning(attempt: EphemeralVmProvisioningAttempt): void {
  const workspace = attempt.workspaceName ? ` for workspace "${attempt.workspaceName}"` : ''
  console.warn(
    `[ephemeral-vm] A create for recipe "${attempt.recipeId}"${workspace} never reported (instance ${attempt.instanceId}, started ${new Date(attempt.startedAt).toISOString()}). ` +
      'The machine may still be running and Orca holds no recipe result for it, so it cannot destroy it — check the provider and delete it by hand.'
  )
}
