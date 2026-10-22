import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'

/**
 * True when the run target the composer would create on is the host the copied workspace already
 * lives on. Git refuses to check a branch out twice on one host, so Orca's create path silently
 * renames the branch instead — the one outcome a locked identity must never produce.
 */
export function isLockedSourceHostTarget({
  sourceHostId,
  sourceRuntimeOwnerEnvironmentId,
  selectedTargetHostIds
}: {
  sourceHostId?: ExecutionHostId | null
  sourceRuntimeOwnerEnvironmentId?: string | null
  /** Every id that names the chosen run target; a setup and a repo row can disagree. */
  selectedTargetHostIds: readonly (ExecutionHostId | null | undefined)[]
}): boolean {
  // Why the runtime owner too: a workspace transported through a paired runtime publishes under
  // its own host id, and the composer can pick either spelling for the same machine.
  const runtimeOwnerHostId = sourceRuntimeOwnerEnvironmentId
    ? toRuntimeExecutionHostId(sourceRuntimeOwnerEnvironmentId)
    : null
  for (const targetHostId of selectedTargetHostIds) {
    if (!targetHostId) {
      continue
    }
    if (targetHostId === sourceHostId || targetHostId === runtimeOwnerHostId) {
      return true
    }
  }
  return false
}
