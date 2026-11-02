/** Where Orca places a project's workspaces.
 *
 *  - `flat` — worktrees sit directly under the root.
 *  - `repo-nested` — the historical nested default: `<root>/<container>/<name>`, where the
 *    container is the checkout's own folder — or the project folder holding it once a clone or
 *    create has nested the primary checkout at `<root>/<project>/<defaultBranch>`.
 *  - `project-folder` — one folder per project, holding the primary checkout and every
 *    worktree: `<root>/<projectFolder>/<defaultBranch>` and `<root>/<projectFolder>/<name>`.
 */
export const WORKTREE_LAYOUT_MODES = ['flat', 'repo-nested', 'project-folder'] as const

export type WorktreeLayoutMode = (typeof WORKTREE_LAYOUT_MODES)[number]

export type OrcaWorkspaceLayout = {
  path: string
  nestWorkspaces: boolean
  /** Absent on records written before the layout mode existed — read those through
   *  `resolveWorktreeLayoutMode`, which derives the mode from `nestWorkspaces`. */
  worktreeLayoutMode?: WorktreeLayoutMode
}

/** The settings slice carrying the placement rule for new workspaces. Declared here so
 *  `GlobalSettings` can intersect it instead of growing its own line budget. */
export type OrcaWorkspaceLayoutSettings = {
  /** Placement rule for new workspaces. Kept optional so a settings file written before
   *  the mode existed stays readable — resolve it with `resolveWorktreeLayoutMode`. */
  worktreeLayoutMode?: WorktreeLayoutMode
}

export const DEFAULT_WORKTREE_LAYOUT_MODE: WorktreeLayoutMode = 'project-folder'

/**
 * Read a layout mode from anything carrying one, including the two legacy shapes that
 * predate it: a settings object whose `nestWorkspaces` is the only switch, and a
 * persisted `OrcaWorkspaceLayout` or `orcaCreationWorkspaceLayout` written the same way.
 *
 * `nestWorkspaces: false` was flat and `true` was repo-nested, so the derivation keeps
 * every previously-created workspace in the mode it was actually created under. An absent
 * boolean reads as repo-nested, matching the historical default.
 */
export function resolveWorktreeLayoutMode(settings: {
  worktreeLayoutMode?: WorktreeLayoutMode
  nestWorkspaces?: boolean
}): WorktreeLayoutMode {
  if (settings.worktreeLayoutMode) {
    return settings.worktreeLayoutMode
  }
  return settings.nestWorkspaces === false ? 'flat' : 'repo-nested'
}

/** The legacy boolean a mode has to keep agreeing with, so older readers stay correct. */
export function layoutModeNestsWorkspaces(mode: WorktreeLayoutMode): boolean {
  return mode !== 'flat'
}

/** True when `path` is a container holding one project's primary checkout and worktrees. */
export function isProjectFolderLayout(mode: WorktreeLayoutMode): boolean {
  return mode === 'project-folder'
}

/** True when a new project's primary checkout goes inside a project folder rather than directly
 *  in the parent the user picked. Both nested layouts do it; only `flat` does not.
 *
 *  Kept apart from `layoutModeNestsWorkspaces` on purpose: that one derives the legacy boolean a
 *  downgrade still reads, while this one is a placement rule. They agree today, and a layout that
 *  nests workspaces without nesting the checkout (or the reverse) would have to split them. */
export function layoutNestsPrimaryCheckout(mode: WorktreeLayoutMode): boolean {
  return mode !== 'flat'
}
