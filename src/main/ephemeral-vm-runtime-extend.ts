import type { Store } from './persistence'
import {
  isEphemeralVmHostActionable,
  type EphemeralVmRuntimeRecord
} from '../shared/ephemeral-vm-runtimes'
import {
  getEphemeralVmRecipeResultConnection,
  getEphemeralVmLifetimeLossError,
  getEphemeralVmRecipeResultPairingCode,
  type EphemeralVmRecipeResult
} from '../shared/ephemeral-vm-recipes'
import { normalizeEphemeralVmLifetimeDuration } from '../shared/ephemeral-vm-lifetime'
import { updateEphemeralVmRuntimeStatus } from '../shared/ephemeral-vm-runtime-store'
import { updateEnvironmentFromPairingCode } from '../shared/runtime-environment-store'
import { getRuntimeRecipeContext } from './ipc/ephemeral-vm-recipe-context'
import { invalidateRuntimeEnvironmentTransport } from './ipc/runtime-environments/runtime-environments'
import {
  connectRuntimeOwnedSshTarget,
  disconnectRuntimeOwnedSshTarget
} from './ephemeral-vm/runtime-ssh'
import { withEphemeralVmRuntimeLock } from './ephemeral-vm-runtime-lock'
import { getSshConnectionManager } from './ssh/targets/ssh-target-registry'
import { contextFromRuntime } from './ephemeral-vm/runtime-service'
import { runEphemeralVmRecipeExtend } from '../shared/ephemeral-vm-recipe-extend-runner'

export type ExtendEphemeralVmRuntimeLeaseArgs = {
  userDataPath: string
  store: Store
  runtimeId: string
  /** The lifetime the caller asked for, in any accepted spelling. */
  lifetime: string
  signal?: AbortSignal
  /** Overrides the hook deadline; for callers (and tests) that own a stricter budget than Orca's. */
  hookTimeoutMs?: number
}

/**
 * How long an extend hook may run before Orca gives up on it.
 *
 * Why a deadline rather than trusting the hook: this call holds the runtime's lifecycle lock, and the
 * reclaim sweep's per-runtime work is gated on that lock, so a hook waiting on a network that never
 * answers would stop every later extend from starting and leave the runtime unreclaimable. The hook is
 * a provider CLI, not something Orca can inspect, so the only bound available is a clock.
 */
export const EPHEMERAL_VM_EXTEND_HOOK_TIMEOUT_MS = 120_000

/**
 * Canonicalize a requested lifetime and refuse anything the recipe does not offer.
 *
 * Why refuse rather than forward it: Orca only ever shows the lifetimes a recipe declared, so a
 * value outside that set means the request did not come from Orca's own UI — and asking a
 * provider for a lease it does not sell would fail deep inside the script instead of here.
 */
export function resolveRequestedEphemeralVmExtendDuration(
  runtime: Pick<EphemeralVmRuntimeRecord, 'extendDurations'>,
  requested: string
): string | null {
  const normalized = normalizeEphemeralVmLifetimeDuration(requested)
  if (!normalized || !runtime.extendDurations?.includes(normalized)) {
    return null
  }
  return normalized
}

export async function extendEphemeralVmRuntimeLease(
  args: ExtendEphemeralVmRuntimeLeaseArgs
): Promise<EphemeralVmRuntimeRecord> {
  // Why the lock: the reclaim sweep decides from a record it read earlier and then awaits work, so
  // without this an extension can land underneath a reclaim that had already made up its mind.
  return withEphemeralVmRuntimeLock(args.runtimeId, () => extendLocked(args))
}

async function extendLocked(
  args: ExtendEphemeralVmRuntimeLeaseArgs
): Promise<EphemeralVmRuntimeRecord> {
  const resolved = getRuntimeRecipeContext(args.store, args.userDataPath, args.runtimeId)
  const existing = resolved.runtime
  const lifetime = resolveRequestedEphemeralVmExtendDuration(existing, args.lifetime)
  if (!lifetime) {
    throw new Error(
      `Recipe "${resolved.recipe.id}" does not offer the lifetime "${args.lifetime}".`
    )
  }
  // Why the shared predicate: it is the same question every action on this host asks, so a lease can
  // never be extended on a machine whose destroy is already racing it.
  if (!isEphemeralVmHostActionable(existing)) {
    throw new Error('This host has already been released, so its lease can no longer be extended.')
  }

  // Why a deadline on the hook: this call holds the runtime's lifecycle lock, so a hook waiting on a
  // network that never answers stops every later extend for this runtime. Composed with the caller's
  // own signal so a cancel keeps working, and kept separate from it so a timeout can be named.
  const hookTimeoutMs = args.hookTimeoutMs ?? EPHEMERAL_VM_EXTEND_HOOK_TIMEOUT_MS
  const deadline = AbortSignal.timeout(hookTimeoutMs)
  const extend = await runEphemeralVmRecipeExtend({
    repoPath: resolved.repo.repo.path,
    // Why the command comes from the snapshot rather than `resolved.recipe`: the hook that extends
    // this lease is the one the recipe declared when it bought the lease, so a later orca.yaml edit
    // cannot redirect an extension at a different script.
    recipe: { ...resolved.recipe, ...(existing.extend ? { extend: existing.extend } : {}) },
    context: contextFromRuntime(resolved.repo.repo.path, existing),
    recipeResult: existing.recipeResult,
    lifetime,
    signal: args.signal ? AbortSignal.any([args.signal, deadline]) : deadline
  })
  if (!extend.ok) {
    // Why leave the record untouched on failure: nothing about the lease moved, so persisting a
    // failure the user can immediately retry would only make the host look broken meanwhile.
    throw new Error(
      deadline.aborted
        ? `Extending the lease did not finish within ${hookTimeoutMs} ms and was stopped. The provider may already have granted the extension, so retry and check the new deadline.`
        : extend.error
    )
  }

  // Why re-read after the hook: nothing takes this lock for the whole hook's duration — a workspace
  // delete during it is deliberate and must not wait — so the record that was actionable when the
  // lease was requested may be tearing down by the time the answer arrives. Writing the new
  // recipeResult onto a `cleaned` record is what made a finished host report "cleanup failed".
  const afterHook = getRuntimeRecipeContext(args.store, args.userDataPath, args.runtimeId).runtime
  if (!isEphemeralVmHostActionable(afterHook)) {
    throw new Error(
      'This host was released while its lease was being extended, so the new deadline was not applied.'
    )
  }

  // Why the shared rule: an answer that loses the deadline would leave a lease the user just paid for
  // with no countdown and no reconciliation. Refusing keeps the record's earlier deadline, so the
  // sweep may release this host before the user retries — acceptable, because a release destroys
  // nothing and the action is retryable against a record that still parses.
  const lostLifetimeError = getEphemeralVmLifetimeLossError(
    afterHook.recipeResult,
    extend.result,
    'Extend'
  )
  if (lostLifetimeError) {
    throw new Error(lostLifetimeError)
  }

  const connectionChanged = !connectionsEqual(afterHook.recipeResult, extend.result)
  const updated = updateEphemeralVmRuntimeStatus(args.userDataPath, afterHook.id, {
    recipeResult: extend.result,
    updatedAt: Date.now()
  })
  const runtime = connectionChanged
    ? await reattachEphemeralVmRuntime({ userDataPath: args.userDataPath, runtime: updated })
    : updated
  await clearStaleEphemeralVmSshFailure(runtime).catch(() => undefined)
  return runtime
}

/**
 * Drop a failed-reconnect verdict this host earned before its lease was extended.
 *
 * Why it matters: the ladder gives up once and then arms no further timer, so `reconnection-failed`
 * persists. Read at the NEW deadline it would look like evidence the host never came back — evidence
 * that predates the extension which bought that time. Clearing it leaves Orca holding no verdict at
 * all until a real attempt produces one.
 */
async function clearStaleEphemeralVmSshFailure(runtime: EphemeralVmRuntimeRecord): Promise<void> {
  const targetId = runtime.sshTargetId
  if (!targetId) {
    return
  }
  const manager = getSshConnectionManager()
  if (manager?.getState(targetId)?.status !== 'reconnection-failed') {
    return
  }
  await manager.disconnect(targetId)
}

function connectionsEqual(left: EphemeralVmRecipeResult, right: EphemeralVmRecipeResult): boolean {
  return (
    JSON.stringify(getEphemeralVmRecipeResultConnection(left)) ===
    JSON.stringify(getEphemeralVmRecipeResultConnection(right))
  )
}

/**
 * Attach a host that the provider re-addressed during the extension.
 *
 * A lease-only extension never reaches here: keeping the working connection means live terminals
 * survive an extension, which is the whole point of extending before the deadline.
 */
async function reattachEphemeralVmRuntime(args: {
  userDataPath: string
  runtime: EphemeralVmRuntimeRecord
}): Promise<EphemeralVmRuntimeRecord> {
  const connection = getEphemeralVmRecipeResultConnection(args.runtime.recipeResult)
  if (connection.type === 'ssh') {
    // Why disconnect first: the target registry reuses a live connection for a target id, so a
    // provider that moved the host would otherwise keep serving the old machine under the new lease.
    await disconnectRuntimeOwnedSshTarget(args.runtime.sshTargetId).catch(() => undefined)
    const ssh = await connectRuntimeOwnedSshTarget({
      runtimeId: args.runtime.id,
      connection
    })
    return updateEphemeralVmRuntimeStatus(args.userDataPath, args.runtime.id, {
      connectionMode: 'ssh',
      sshTargetId: ssh.targetId,
      ...(ssh.environmentId ? { runtimeEnvironmentId: ssh.environmentId } : {})
    })
  }
  const environmentId = args.runtime.runtimeEnvironmentId
  const pairingCode = getEphemeralVmRecipeResultPairingCode(args.runtime.recipeResult)
  if (!environmentId || !pairingCode) {
    throw new Error(
      'Extend changed the host connection but returned no Orca Server pairing code to reattach it with.'
    )
  }
  updateEnvironmentFromPairingCode(args.userDataPath, environmentId, { pairingCode })
  invalidateRuntimeEnvironmentTransport(environmentId)
  return updateEphemeralVmRuntimeStatus(args.userDataPath, args.runtime.id, {
    connectionMode: 'orca-server'
  })
}
