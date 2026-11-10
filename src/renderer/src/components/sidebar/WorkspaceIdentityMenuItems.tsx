import type React from 'react'
import { Pencil, Server } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import type { AddWorktreeToAnotherHostRefusal } from './worktree-to-host-composer-data'
import type { WorktreeContextMenuModel } from './workspace-actions/context-menu/use-worktree-context-menu-model'

function getRefusalReason(reason: AddWorktreeToAnotherHostRefusal): string {
  switch (reason) {
    case 'folder-project':
      return translate(
        'auto.components.sidebar.WorktreeContextMenu.copyRefusedFolderProject',
        'Folder projects have no branch to copy to another host.'
      )
    case 'project-without-shared-remote':
      return translate(
        'auto.components.sidebar.WorktreeContextMenu.copyRefusedNoSharedRemote',
        'Add a remote to this project first — another host can only find it through one.'
      )
    case 'publish-remote-not-recreatable':
      return translate(
        'auto.components.sidebar.WorktreeContextMenu.copyRefusedPublishRemote',
        "This workspace's branch lives on a remote another host can't recreate."
      )
  }
}

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
  const t = useTranslate()
  const { addToAnotherHost, handleAddToAnotherHost, handleRename, isDeleting, isMultiContext } =
    model
  if (isMultiContext) {
    return null
  }
  return (
    <>
      <DropdownMenuItem onSelect={handleRename} disabled={isDeleting}>
        <Pencil className="size-3.5" />
        {t('auto.components.sidebar.WorktreeContextMenu.439fa94d53', 'Update')}
      </DropdownMenuItem>
      {addToAnotherHost.kind === 'hidden' ? null : addToAnotherHost.kind === 'available' ? (
        <DropdownMenuItem onSelect={handleAddToAnotherHost} disabled={isDeleting}>
          <Server className="size-3.5" />
          {t(
            'auto.components.sidebar.WorktreeContextMenu.addToAnotherHost',
            'Add to another host…'
          )}
        </DropdownMenuItem>
      ) : (
        // Why: a refused row keeps the action visible with its reason, so the user learns the
        // constraint instead of hunting for a menu item that never appears.
        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <DropdownMenuItem disabled>
                <Server className="size-3.5" />
                {t(
                  'auto.components.sidebar.WorktreeContextMenu.addToAnotherHost',
                  'Add to another host…'
                )}
              </DropdownMenuItem>
            </div>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8} className="max-w-[200px]">
            {getRefusalReason(addToAnotherHost.reason)}
          </TooltipContent>
        </Tooltip>
      )}
    </>
  )
}
