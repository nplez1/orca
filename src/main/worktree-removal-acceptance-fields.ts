import type { RemoveWorktreeResult } from '../shared/worktree/create-types'

/**
 * Acceptance fields are decided before Git runs; the finish result describes what Git actually did,
 * so it wins any collision. The two warnings are joined instead, because each names something
 * different the user may have to act on.
 */
export function withRemovalAcceptanceFields(
  result: RemoveWorktreeResult,
  acceptance: RemoveWorktreeResult
): RemoveWorktreeResult {
  const warning =
    acceptance.warning && result.warning
      ? `${acceptance.warning} ${result.warning}`
      : (acceptance.warning ?? result.warning)
  return { ...acceptance, ...result, ...(warning ? { warning } : {}) }
}
