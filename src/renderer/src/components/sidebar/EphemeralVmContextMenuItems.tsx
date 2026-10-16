import { useCallback } from 'react'
import { Play } from 'lucide-react'
import { toast } from 'sonner'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import {
  findEphemeralVmRuntimeForWorkspace,
  isEphemeralVmHostActionable,
  useEphemeralVmRuntimes
} from '@/hooks/useEphemeralVmRuntimes'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import type { EphemeralVmContextMenuItem } from '../../../../shared/ephemeral-vm-runtimes'

/** Just the parts of the workspace context menu this list reads, so a test needs no store. */
export type EphemeralVmContextMenuItemsModel = {
  worktree: { id: string; path: string }
  isMultiContext: boolean
  isDeleting: boolean
}

/**
 * The extra actions a workspace's environment recipe declared.
 *
 * Why flat items rather than a submenu: a recipe declares these because the user asked for that
 * action by name — "Launch VNC" is the whole intent — so the menu the author wrote is the menu the
 * user sees. A submenu would hide a two-item recipe behind a third click.
 *
 * Why the recipe snapshot and not a live `orca.yaml` read: the click runs a script, and which script
 * that is was decided when the host was created, exactly as for the other recipe hooks.
 */
export function EphemeralVmContextMenuItems({
  model
}: {
  model: EphemeralVmContextMenuItemsModel
}): React.JSX.Element | null {
  const { worktree, isMultiContext, isDeleting } = model
  const records = useEphemeralVmRuntimes()
  const runtime = findEphemeralVmRuntimeForWorkspace(records, worktree.id)

  const handleRun = useCallback(
    async (item: EphemeralVmContextMenuItem): Promise<void> => {
      if (!runtime) {
        return
      }
      // Why a toast rather than a per-item pending state: the menu closes on select, so a
      // "Running…" row is never on screen. The click has exactly one place to report itself, and the
      // loading toast is what makes a slow script visible before its outcome replaces it.
      const toastId = toast.loading(
        translate(
          'auto.components.sidebar.EphemeralVmContextMenuItems.running',
          'Running {{value0}}…',
          { value0: item.label }
        )
      )
      try {
        await window.api.ephemeralVm.runContextMenuItem({
          runtimeId: runtime.id,
          itemId: item.id,
          workspacePath: worktree.path
        })
        toast.success(
          translate(
            'auto.components.sidebar.EphemeralVmContextMenuItems.ranItem',
            'Ran {{value0}}',
            {
              value0: item.label
            }
          ),
          { id: toastId }
        )
      } catch (cause) {
        // Why unwrapped: Electron prefixes every rejection with the channel it came from, so the
        // script's own message would arrive buried — and only the script knows which machine refused.
        toast.error(
          extractIpcErrorMessage(
            cause,
            translate(
              'auto.components.sidebar.EphemeralVmContextMenuItems.failed',
              'Couldn’t run {{value0}}',
              { value0: item.label }
            )
          ),
          { id: toastId }
        )
      }
    },
    [runtime, worktree.path]
  )

  // Why the multi-context menu has none: that menu acts on a selection, and an item belongs to one
  // workspace's host. Why a host that is gone or going has none: main refuses the click outright.
  const items =
    isMultiContext || !runtime || !isEphemeralVmHostActionable(runtime)
      ? []
      : (runtime.contextMenuItems ?? [])
  if (items.length === 0) {
    return null
  }

  return (
    <>
      {items.map((item) => (
        <DropdownMenuItem key={item.id} disabled={isDeleting} onSelect={() => void handleRun(item)}>
          <Play className="size-3.5" />
          {item.label}
        </DropdownMenuItem>
      ))}
    </>
  )
}
