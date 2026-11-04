import type { RemoveWorktreeResult } from '../shared/worktree/create-types'

/**
 * Acceptance fields are known before Git runs; the finish step can add its own warning (a folder it
 * could not delete). Neither warning may be dropped, and the acceptance one was decided first.
 */
export function withRemovalAcceptanceFields(
  result: RemoveWorktreeResult,
  acceptance: RemoveWorktreeResult
): RemoveWorktreeResult {
  const warning =
    acceptance.warning && result.warning
      ? `${acceptance.warning} ${result.warning}`
      : (acceptance.warning ?? result.warning)
  return { ...result, ...acceptance, ...(warning ? { warning } : {}) }
}
