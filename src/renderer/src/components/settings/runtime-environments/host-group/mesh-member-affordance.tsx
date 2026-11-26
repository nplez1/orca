import { useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { HostMeshMemberView } from '../../../../../../preload/api/host-mesh-api'
import { LoadingSpinner } from '../../../ui/LoadingSpinner'
import { Button } from '../../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../../ui/dialog'
import { ServerRowChip } from '../../host-rows/ServerListRow'
import { hostGroupMemberStatus } from './host-group-copy'
import { runHostMeshAction, useHostMeshSnapshot } from './host-mesh-shared-state'
import { MeshMemberRenameDialog } from './mesh-member-rename-dialog'

/**
 * One paired host's place in the mesh, rendered inside that host's own row.
 *
 * Why here rather than in a list of its own: the group is a property of a host you have already paired, so a
 * second list repeating those hosts made the owner read the same machine twice and left them guessing which
 * copy to act on. Nothing renders for a host that is not a member: whatever the mesh has to say is about a
 * pairing, and a host with no pairing to it has nothing to say.
 */
export function MeshMemberAffordance({
  environmentId
}: {
  environmentId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const snapshot = useHostMeshSnapshot()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const member = memberForEnvironment(snapshot?.members ?? [], environmentId)

  // Why the switch is not checked: an owner who turns mesh mode off still has to be able to eject a member — the
  // pairing is what an Eject ends, and the row is the only place it can be ended from.
  if (member === null) {
    return null
  }
  const status = hostGroupMemberStatus(member.status, t)

  return (
    <>
      <ServerRowChip>
        <span className="flex items-center gap-1">
          <span className="text-muted-foreground">
            {t('auto.components.settings.hostGroup.meshChip', 'Mesh')}
          </span>
          <span className="text-foreground">{status.label}</span>
        </span>
      </ServerRowChip>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={busy}
        onClick={() => setRenaming(true)}
      >
        {t('auto.components.settings.hostGroup.rename', 'Rename…')}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={busy}
        onClick={() => setConfirming(true)}
      >
        {busy ? <LoadingSpinner className="size-3" /> : null}
        {t('auto.components.settings.hostGroup.eject', 'Eject')}
      </Button>
      {renaming ? (
        <MeshMemberRenameDialog member={member} open onOpenChange={() => setRenaming(false)} />
      ) : null}
      <Dialog open={confirming} onOpenChange={(open) => !open && !busy && setConfirming(false)}>
        <DialogContent className="max-w-sm sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {t('auto.components.settings.hostGroup.ejectTitle', 'Eject member')}
            </DialogTitle>
            <DialogDescription>
              {t(
                'auto.components.settings.hostGroup.ejectDescription',
                'This computer forgets the pairing in both directions and tells the member to drop it. The member keeps its own copy of the mesh.'
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
            <div className="truncate font-medium">{member.label}</div>
            <div className="mt-0.5 truncate font-mono text-muted-foreground">{member.hostKey}</div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
              {t('auto.components.settings.hostGroup.cancel', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                void runHostMeshAction((api) => api.remove(member.hostKey))
                  .then(() => setConfirming(false))
                  .catch(() => undefined)
                  .finally(() => setBusy(false))
              }}
            >
              {t('auto.components.settings.hostGroup.ejectConfirm', 'Eject')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Why by environment: a row knows its paired environment, and the member list is keyed by machine. */
function memberForEnvironment(
  members: readonly HostMeshMemberView[],
  environmentId: string
): HostMeshMemberView | null {
  return members.find((member) => member.environmentId === environmentId) ?? null
}
