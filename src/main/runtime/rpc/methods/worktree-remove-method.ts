import { getLocalWorktreeCatalogVersion } from '../../../local-worktree-scan-generation'
import { getExplicitWorktreeIdSelector } from '../../runtime-worktree-selection'
import { splitWorktreeId } from '../../../../shared/worktree/id'
import { defineMethod } from '../core'
import { resolvePairedCallerHostId } from './paired-caller-host-id'
import { readsWorktreeRemovalMarker } from '../worktree-removal-marker-projection'
import { queueWorkspaceDelete } from '../../workspaces/workspace-lifecycle-commands'
import { WorktreeRemove } from '../../../../shared/rpc-contract/worktree-params'

export const WORKTREE_REMOVE_METHOD = defineMethod({
  name: 'worktree.rm',
  permission: 'workspace',
  params: WorktreeRemove,
  handler: async (params, context) => {
    const { runtime } = context
    // Translate a paired client's runtime-local host spelling before host-qualified reads.
    let resolvedHostId = resolvePairedCallerHostId(
      () => runtime.listRepos(),
      params.worktree,
      params.hostId
    )
    // Older mobile clients omit hostId, so resolve through the ambiguity gate
    // before pinning removal. An ambiguous selector still fails closed: two
    // hosts own the id and an unqualified client cannot say which it meant.
    if (!resolvedHostId) {
      try {
        resolvedHostId = (await runtime.showManagedWorktree(params.worktree)).hostId
        if (!resolvedHostId) {
          throw new Error('worktree.rm could not resolve the workspace host')
        }
      } catch (error) {
        // 'selector_not_found' is not a failure to attribute — Git simply no
        // longer lists the path. A delete legitimately arrives in that state and
        // `removeManagedWorktree` handles it, so a stale workspace stays
        // deletable by a client that sends no host. Anything else propagates.
        if (!(error instanceof Error) || error.message !== 'selector_not_found') {
          throw error
        }
      }
    }
    // Why parsed, not resolved: an `id:` selector (what clients send) names its repo, and a second
    // resolution costs a scan and throws for an id two hosts share. Other selectors stay unstamped.
    const explicitWorktreeId = getExplicitWorktreeIdSelector(params.worktree)
    const repoId = explicitWorktreeId ? splitWorktreeId(explicitWorktreeId)?.repoId : undefined
    const result = await queueWorkspaceDelete(
      runtime,
      params.worktree,
      resolvedHostId,
      params,
      (removal) =>
        runtime.removeManagedWorktree(params.worktree, {
          ...removal,
          deleteRemoteBranch: params.deleteRemoteBranch === true,
          // Why: only a client that shows the `removing` marker can wait out Git's delete; older
          // clients get the acceptance and never see the row again.
          ...(readsWorktreeRemovalMarker(context) ? { waitForBackgroundRemoval: true } : {})
        })
    )
    return {
      removed: true,
      ...result,
      ...(repoId ? { catalogVersion: getLocalWorktreeCatalogVersion(repoId) } : {})
    }
  }
})
