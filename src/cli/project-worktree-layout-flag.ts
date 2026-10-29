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

/** Confirms the host applied `--worktree-layout` by comparing it with the mode the host reports
 *  in effect.
 *
 *  A host that reports a different mode refused the flag, and that is an error. A host that
 *  reports no mode at all is a build from before the field: it may have applied the setting (the
 *  fork has accepted it since before this field existed) or stripped it (upstream does), and
 *  nothing here can tell which — so it says so on stderr instead of claiming either. */
export function confirmWorktreeLayoutApplied(
  requested: WorktreeLayoutMode | undefined,
  result: { worktreeLayoutMode?: WorktreeLayoutMode }
): void {
  if (!requested) {
    return
  }
  const reported = result.worktreeLayoutMode
  if (reported === requested) {
    return
  }
  if (reported === undefined) {
    console.error(
      `warning: this host did not confirm --worktree-layout ${requested}. It predates that report, so the mode may or may not have applied; check its settings, or update Orca there. Any other change in this call did apply.`
    )
    return
  }
  throw new RuntimeClientError(
    'incompatible_runtime',
    `This host did not apply --worktree-layout ${requested}: it kept ${reported}. Any other change in this call did apply; update Orca on that host, or set the mode in its settings.`
  )
}
