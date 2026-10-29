import { WORKTREE_LAYOUT_MODES, type WorktreeLayoutMode } from '../shared/orca-workspace-layout'
import { getOptionalStringFlag } from './flags'
import { RuntimeClientError } from './runtime-client'

function isWorktreeLayoutMode(value: string): value is WorktreeLayoutMode {
  return WORKTREE_LAYOUT_MODES.some((mode) => mode === value)
}

/** Host-wide placement for new workspaces; see `applyProjectSetupWorktreeLayoutMode` on the runtime side. */
export function getOptionalWorktreeLayoutMode(
  flags: Map<string, string | boolean>
): WorktreeLayoutMode | undefined {
  const mode = getOptionalStringFlag(flags, 'worktree-layout')
  if (mode === undefined) {
    return undefined
  }
  if (isWorktreeLayoutMode(mode)) {
    return mode
  }
  throw new RuntimeClientError(
    'invalid_argument',
    `--worktree-layout must be one of ${WORKTREE_LAYOUT_MODES.join(', ')}`
  )
}

/** Confirms the host applied `--worktree-layout` by comparing it with the mode the host
 *  reports in effect.
 *
 *  A host built before this field — upstream Orca included — validates the setup params with a
 *  closed schema, so the unknown key is stripped and the call succeeds having changed nothing.
 *  Its answer therefore carries no mode, and that absence is the failure: reporting success for
 *  a placement change that did not happen is what leaves every project on that host unchanged. */
export function assertWorktreeLayoutApplied(
  requested: WorktreeLayoutMode | undefined,
  result: { worktreeLayoutMode?: WorktreeLayoutMode }
): void {
  if (!requested || result.worktreeLayoutMode === requested) {
    return
  }
  const reported = result.worktreeLayoutMode
  throw new RuntimeClientError(
    'incompatible_runtime',
    reported === undefined
      ? `This host did not apply --worktree-layout ${requested}: it cannot report its placement mode, so it predates the flag and ignored it. Update Orca on that host and try again.`
      : `This host did not apply --worktree-layout ${requested}: it reports ${reported} in effect. Update Orca on that host, or set the mode in its settings.`
  )
}
