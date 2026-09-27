import type { WorkspacePathSearchOwnerIdentity } from '../../shared/workspace-path-search-contract'
import { parseWslPath } from '../wsl'

/**
 * WSL roots are validated more often and expire sooner: the watcher polls only two directory
 * levels, so a deep change is not visible to events and validation is the recovery path.
 */
const WORKSPACE_PATH_INDEX_WSL_VALIDATION_INTERVAL_MILLISECONDS = 60_000
const WORKSPACE_PATH_INDEX_WSL_FRESHNESS_DEADLINE_MILLISECONDS = 2 * 60_000
const WORKSPACE_PATH_INDEX_LOCAL_VALIDATION_INTERVAL_MILLISECONDS = 5 * 60_000
const WORKSPACE_PATH_INDEX_LOCAL_FRESHNESS_DEADLINE_MILLISECONDS = 15 * 60_000

/** Cadence is scoped to the owner's root: a WSL root must not inherit the local deadlines. */
export function workspacePathIndexValidationIntervalForOwner(
  owner: WorkspacePathSearchOwnerIdentity
): number {
  return ownsWslRoot(owner)
    ? WORKSPACE_PATH_INDEX_WSL_VALIDATION_INTERVAL_MILLISECONDS
    : WORKSPACE_PATH_INDEX_LOCAL_VALIDATION_INTERVAL_MILLISECONDS
}

export function workspacePathIndexFreshnessDeadlineForOwner(
  owner: WorkspacePathSearchOwnerIdentity
): number {
  return ownsWslRoot(owner)
    ? WORKSPACE_PATH_INDEX_WSL_FRESHNESS_DEADLINE_MILLISECONDS
    : WORKSPACE_PATH_INDEX_LOCAL_FRESHNESS_DEADLINE_MILLISECONDS
}

function ownsWslRoot(owner: WorkspacePathSearchOwnerIdentity): boolean {
  return parseWslPath(owner.authorizedCanonicalRoot) !== null
}
