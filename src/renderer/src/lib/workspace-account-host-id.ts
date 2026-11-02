import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { forgeOwnerHostIdForWorkspace } from '@/runtime/forge-credential-target'

/**
 * The account host a workspace's provider reads route by: the paired server that transports the
 * workspace when one does, else the workspace row's own host, else its repository's, else this app.
 * Why the server first: an SSH workspace behind a paired server keeps `ssh:<target>` as its host and
 * names the server separately, and that server holds the Jira/Linear credentials, not this computer.
 * One precedence for every surface, so a card and an issue pane cannot name different accounts.
 */
export function workspaceAccountHostId(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | null | undefined,
  workspace: Pick<Worktree, 'hostId' | 'runtimeOwnerEnvironmentId'> | null | undefined
): ExecutionHostId {
  // Why the guard only runs with a repo row: upstream's `forgeOwnerHostIdForWorkspace` rejects a
  // repository that names a different host than the workspace, and there is nothing to compare when
  // the row has not loaded yet. The documented precedence still applies there — the workspace row's
  // own host (its paired server first) wins over this app.
  const owner = repo
    ? forgeOwnerHostIdForWorkspace(repo, workspace)
    : workspace?.runtimeOwnerEnvironmentId
      ? toRuntimeExecutionHostId(workspace.runtimeOwnerEnvironmentId)
      : (workspace?.hostId ?? null)
  return normalizeExecutionHostId(owner) ?? LOCAL_EXECUTION_HOST_ID
}
