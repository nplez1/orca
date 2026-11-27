import { useEffect, useState, useSyncExternalStore } from 'react'
import { Pencil, UserMinus } from 'lucide-react'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useTranslate } from '@/i18n/use-translate'
import type { HostMeshMemberView } from '../../../../../../preload/api/host-mesh-api'
import { Button } from '../../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../../ui/dialog'
import { DropdownMenuItem } from '../../../ui/dropdown-menu'
import { ServerRowChip } from '../../host-rows/ServerListRow'
import { hostGroupMemberStatus } from './host-group-copy'
import { runHostMeshAction, useHostMeshSnapshot } from './host-mesh-shared-state'
import { MeshMemberRenameDialog } from './mesh-member-rename-dialog'

/** What the row's overflow menu can ask the member for. */
export type MeshMemberAction = 'rename' | 'eject'

/**
 * One paired host's place in the mesh, rendered inside that host's own row.
 *
 * Why here rather than in a list of its own: the group is a property of a host you have already paired, so a
 * second list repeating those hosts made the owner read the same machine twice and left them guessing which
 * copy to act on. Nothing renders for a host that is not a member: whatever the mesh has to say is about a
 * pairing, and a host with no pairing to it has nothing to say.
 *
 * Why three pieces and not one: the row keeps the chip, because a chip is a fact about the pairing; the two
 * actions belong in the row's overflow menu with every other action on that host, because two ghost buttons
 * beside the status read as part of the host's identity and crowded the row at every width.
 */
export function MeshMemberChip({
  environmentId
}: {
  environmentId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const member = useMeshMember(environmentId)
  if (member === null) {
    return null
  }
  const status = hostGroupMemberStatus(member.status, t)

  return (
    <ServerRowChip>
      <span className="flex items-center gap-1">
        <span className="text-muted-foreground">
          {t('auto.components.settings.hostGroup.meshChip', 'Mesh')}
        </span>
        <span className="text-foreground">{status.label}</span>
      </span>
    </ServerRowChip>
  )
}

/**
 * The whole row affordance: the chip, plus the dialog its menu action opens.
 *
 * Why one element for both: the chip slot and the menu are two slots of upstream's row, so this is the one
 * piece of the feature that file renders, and the dialog keeps its state here rather than in that file.
 */
export function MeshMemberAffordance({
  environmentId
}: {
  environmentId: string
}): React.JSX.Element {
  // Why the close on unmount: the store outlives the row, so a dialog left open by a row that went away would
  // reopen on the row that replaced it.
  useEffect(() => () => closeMeshAction(environmentId), [environmentId])

  return (
    <>
      <MeshMemberChip environmentId={environmentId} />
      <MeshMemberDialogs environmentId={environmentId} />
    </>
  )
}

/** The member's actions, for the row's `...` menu. Nothing renders for a host that is not a member. */
export function MeshMemberMenuItems({
  environmentId
}: {
  environmentId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const member = useMeshMember(environmentId)
  if (member === null) {
    return null
  }

  return (
    <>
      <DropdownMenuItem onSelect={() => setOpenMeshAction(environmentId, 'rename')}>
        <Pencil />
        {t('auto.components.settings.hostGroup.rename', 'Rename…')}
      </DropdownMenuItem>
      <DropdownMenuItem
        variant="destructive"
        onSelect={() => setOpenMeshAction(environmentId, 'eject')}
      >
        <UserMinus />
        {t('auto.components.settings.hostGroup.eject', 'Eject')}
      </DropdownMenuItem>
    </>
  )
}

/**
 * The two dialogs the menu opens.
 *
 * Why outside the menu and not inside a menu item: a dropdown unmounts its content on select, so a dialog
 * rendered there would disappear with it. The chip slot renders this, which stays mounted.
 */
export function MeshMemberDialogs({
  environmentId
}: {
  environmentId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const member = useMeshMember(environmentId)
  const action = useOpenMeshAction(environmentId)
  const [busy, setBusy] = useState(false)
  const mountedRef = useMountedRef()

  if (member === null || action === null) {
    return null
  }
  const close = (): void => closeMeshAction(environmentId)
  if (action === 'rename') {
    return <MeshMemberRenameDialog member={member} open onOpenChange={close} />
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && close()}>
      <DialogContent className="max-w-sm sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {t('auto.components.settings.hostGroup.ejectTitle', 'Eject member')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'auto.components.settings.hostGroup.ejectDescription',
              'This computer forgets the pairing in both directions, every other member is told to forget it too, and that machine leaves the group on its own when its next pass sees the notice. It is permanent: the removal is a tombstone every member keeps, so that machine cannot be introduced back into this mesh.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
          <div className="truncate font-medium">{member.label}</div>
          <div className="mt-0.5 truncate font-mono text-muted-foreground">{member.hostKey}</div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={close}>
            {t('auto.components.settings.hostGroup.cancel', 'Cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              // Why the dialog closes only on success: a refused Eject leaves the member in place, and a dialog that
              // vanished would read as one that worked.
              void runHostMeshAction((api) => api.remove(member.hostKey))
                .then(() => {
                  if (mountedRef.current) {
                    close()
                  }
                })
                .catch(() => undefined)
                .finally(() => {
                  if (mountedRef.current) {
                    setBusy(false)
                  }
                })
            }}
          >
            {t('auto.components.settings.hostGroup.ejectConfirm', 'Eject')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Which row's action dialog is open.
 *
 * Why a module store rather than a prop: the menu that opens a dialog and the chip slot that renders it are two
 * slots of upstream's row, so no component of this feature owns both, and one store keeps that row two lines.
 */
type OpenMeshAction = { environmentId: string; action: MeshMemberAction } | null

let openMeshActionState: OpenMeshAction = null
const openMeshActionListeners = new Set<() => void>()

function subscribeOpenMeshAction(listener: () => void): () => void {
  openMeshActionListeners.add(listener)
  return () => {
    openMeshActionListeners.delete(listener)
  }
}

function notifyOpenMeshAction(): void {
  for (const listener of openMeshActionListeners) {
    listener()
  }
}

function setOpenMeshAction(environmentId: string, action: MeshMemberAction): void {
  openMeshActionState = { environmentId, action }
  notifyOpenMeshAction()
}

function closeMeshAction(environmentId: string): void {
  if (openMeshActionState?.environmentId !== environmentId) {
    return
  }
  openMeshActionState = null
  notifyOpenMeshAction()
}

/** A primitive snapshot, so a store change for one row does not re-render the others. */
function useOpenMeshAction(environmentId: string): MeshMemberAction | null {
  return useSyncExternalStore(subscribeOpenMeshAction, () =>
    openMeshActionState?.environmentId === environmentId ? openMeshActionState.action : null
  )
}

/** Why by environment: a row knows its paired environment, and the member list is keyed by machine. */
function useMeshMember(environmentId: string): HostMeshMemberView | null {
  const snapshot = useHostMeshSnapshot()
  const members = snapshot?.members ?? NO_MEMBERS
  return members.find((member) => member.environmentId === environmentId) ?? null
}

const NO_MEMBERS: readonly HostMeshMemberView[] = []
