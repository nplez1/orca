import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../../../shared/execution-host'
import type { DetectedWorktreeListResult } from '../../../../../../shared/worktree/types'
import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from './worktree-slice-types'
import { mergeFetchedWorktrees } from './fetched-worktree-merge'
import { getProjectHostSetupForRepoHost } from './worktree-host-ownership'

export function createHydrateCachedWorktrees(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): Pick<WorktreeSlice, 'hydrateCachedWorktrees'> {
  return {
    hydrateCachedWorktrees: (results: readonly DetectedWorktreeListResult[]) => {
      for (const result of results) {
        if (result.source !== 'cache' || result.authoritative) {
          continue
        }
        const state = get()
        const repo = state.repos.find(
          (candidate) =>
            candidate.id === result.repoId &&
            getRepoExecutionHostId(candidate) === LOCAL_EXECUTION_HOST_ID
        )
        if (!repo) {
          continue
        }
        mergeFetchedWorktrees(set, {
          repoId: repo.id,
          hostId: LOCAL_EXECUTION_HOST_ID,
          ownerWasMissingAtStart: false,
          requestStartedWorktrees: state.worktreesByRepo[repo.id],
          setup: getProjectHostSetupForRepoHost(state, repo.id, LOCAL_EXECUTION_HOST_ID),
          refresh: {
            status: 'admitted',
            result,
            executionHostId: LOCAL_EXECUTION_HOST_ID
          },
          purgeRemovedWorktrees: false
        })
      }
    }
  }
}
