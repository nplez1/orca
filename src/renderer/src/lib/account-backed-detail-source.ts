import {
  ACCOUNT_BACKED_TASK_SOURCE_PROJECT_ID,
  normalizeTaskSourceContext,
  type TaskProvider,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import type { ExecutionHostId } from '../../../shared/execution-host'

/**
 * The account-backed task source for a provider on `hostId`: the owner a caller names when it has
 * no source row of its own. What it unblocks is a row-less pane on a workspace whose creation-time
 * task source is unknown — the workspace's own host is the account the link belongs to, and
 * without this the caller would have to fall back to whichever server is focused.
 */
export function accountBackedDetailSource(
  provider: TaskProvider,
  hostId: ExecutionHostId
): TaskSourceContext {
  const source = normalizeTaskSourceContext({
    provider,
    projectId: ACCOUNT_BACKED_TASK_SOURCE_PROJECT_ID,
    hostId
  })
  if (!source) {
    // Unreachable: both the provider and the project id are constants.
    throw new Error(`Could not build the account-backed ${provider} source`)
  }
  return source
}
