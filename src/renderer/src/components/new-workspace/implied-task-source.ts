import type { SmartWorkspaceNameSelection } from './smart-workspace-name-field-model'

/** The source a task-launched composer opened with, identified by its issue URL.
 *
 *  Why an identity rather than a boolean: the composer's own selection can move
 *  under a flag fixed at open time. A project switch drops a repo-scoped link and
 *  "create more" resets the source, and in both cases a stale `true` would keep
 *  presenting whatever source replaced it as the fixed, non-clearable one — with
 *  the Advanced name field hidden to match. */
export function resolveImpliedTaskSource(
  impliedTaskSourceUrl: string | null | undefined,
  selected: SmartWorkspaceNameSelection | null
): SmartWorkspaceNameSelection | null {
  if (!impliedTaskSourceUrl || !selected) {
    return null
  }
  return selected.url === impliedTaskSourceUrl ? selected : null
}
