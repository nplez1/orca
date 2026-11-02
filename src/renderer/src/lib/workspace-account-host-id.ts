import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'

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
  // Why not upstream's `forgeOwnerHostIdForWorkspace`: its forge-owner guard throws when the repo row
  // names another host than the workspace, and every caller here renders a card or a pane, so one
  // stale row would crash the surface. The precedence below resolves the owner instead.
  const serverId = workspace?.runtimeOwnerEnvironmentId?.trim()
  const owner = serverId
    ? toRuntimeExecutionHostId(serverId)
    : (workspace?.hostId ?? (repo ? getRepoExecutionHostId(repo) : null))
  return normalizeExecutionHostId(owner) ?? LOCAL_EXECUTION_HOST_ID
}
