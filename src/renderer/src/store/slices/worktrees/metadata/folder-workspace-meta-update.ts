import { translate } from '@/i18n/i18n'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { WorkspaceAttachmentMutation } from '../../../../../../shared/workspace-attachment-mutation'
import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
import type { AppState } from '../../../types'
import { getFolderWorkspaceMetaUpdates } from '../listing/detected-worktree-meta'

type FolderWorkspaceMetaResult = { ok: true } | { ok: false; error: string }

/**
 * The folder-workspace branch of a worktree metadata update: a folder row takes only the fields the
 * folder update accepts, and it reports its own rejection — a refused update reconciles the
 * optimistic write away, so answering ok would show the dialog a save that silently undid itself.
 */
export async function updateFolderWorkspaceMeta(args: {
  state: Pick<AppState, 'updateFolderWorkspace'>
  folderWorkspaceId: string
  updates: Partial<WorktreeMeta> & WorkspaceAttachmentMutation
  executionHostId?: ExecutionHostId
}): Promise<FolderWorkspaceMetaResult> {
  const folderUpdates = getFolderWorkspaceMetaUpdates(args.updates)
  if (Object.keys(folderUpdates).length === 0) {
    return { ok: true }
  }
  try {
    const updated = await args.state.updateFolderWorkspace(args.folderWorkspaceId, folderUpdates, {
      executionHostId: args.executionHostId
    })
    return updated
      ? { ok: true }
      : {
          ok: false,
          error: translate(
            'auto.store.slices.worktrees.a17f4d2e93',
            'Could not update this workspace.'
          )
        }
  } catch (err) {
    console.error('Failed to update folder workspace meta:', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
