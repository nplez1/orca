import type React from 'react'
import { Pencil, Server } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import type { WorktreeContextMenuModel } from './use-worktree-context-menu-model'

/**
 * Workspace-identity actions: what this workspace *is* (its name) and where else it should
 * exist (a checkout of the same branch on another host). Both are per-workspace, so a
 * multi-selection offers neither.
 */
export function WorkspaceIdentityMenuItems({
  model
}: {
  model: WorktreeContextMenuModel
}): React.JSX.Element | null {
  const { canAddToAnotherHost, handleAddToAnotherHost, handleRename, isDeleting, isMultiContext } =
    model
  if (isMultiContext) {
    return null
  }
  return (
    <>
      <DropdownMenuItem onSelect={handleRename} disabled={isDeleting}>
        <Pencil className="size-3.5" />
        {translate('auto.components.sidebar.WorktreeContextMenu.439fa94d53', 'Update')}
      </DropdownMenuItem>
      {canAddToAnotherHost ? (
        <DropdownMenuItem onSelect={handleAddToAnotherHost} disabled={isDeleting}>
          <Server className="size-3.5" />
          {translate(
            'auto.components.sidebar.WorktreeContextMenu.addToAnotherHost',
            'Add to another host…'
          )}
        </DropdownMenuItem>
      ) : null}
    </>
  )
}
