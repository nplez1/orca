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
