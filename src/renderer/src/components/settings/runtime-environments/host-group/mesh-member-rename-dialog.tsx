import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../../ui/dialog'
import { Button } from '../../../ui/button'
import { Input } from '../../../ui/input'
import { Label } from '../../../ui/label'
import { useTranslate } from '@/i18n/use-translate'
import { HOST_MESH_MAX_LABEL_CHARS } from '../../../../../../shared/host-mesh/host-mesh-contract'
import type { HostMeshMemberView } from '../../../../../../preload/api/host-mesh-api'
import { runHostMeshAction } from './host-mesh-shared-state'

/**
 * Renames a machine for the whole mesh.
 *
 * Why it is not the sidebar's rename dialog: that one writes a label only this computer shows. A machine's name
 * belongs to the group, so this writes through the mesh and every member — the machine itself included — reads it
 * on its next pass.
 */
export function MeshMemberRenameDialog({
  member,
  open,
  onOpenChange
}: {
  member: HostMeshMemberView
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [value, setValue] = useState(member.label)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<'invalid' | 'unreachable' | null>(null)

  // Seed on every open so a cancelled draft cannot reappear under the name the mesh has now.
  const [seededFor, setSeededFor] = useState({ open, label: member.label })
  if (seededFor.open !== open || seededFor.label !== member.label) {
    setSeededFor({ open, label: member.label })
    if (open) {
      setValue(member.label)
      setFailure(null)
    }
  }

  const trimmed = value.trim()
  const save = (): void => {
    if (trimmed === '' || busy) {
      return
    }
    setBusy(true)
    setFailure(null)
    void runHostMeshAction((api) => api.rename(member.hostKey, trimmed))
      .then(() => onOpenChange(false))
      .catch((error: unknown) =>
        setFailure(
          error instanceof Error && error.message.includes('host_mesh_invalid_request')
            ? 'invalid'
            : 'unreachable'
        )
      )
      .finally(() => setBusy(false))
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t('auto.components.settings.hostGroup.renameTitle', 'Rename this computer')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'auto.components.settings.hostGroup.renameDescription',
              'The mesh keeps this name, so every computer that lists it uses it too. A name you typed when pairing counts as one.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="mesh-member-rename-input">
            {t('auto.components.settings.hostGroup.renameField', 'Name')}
          </Label>
          <Input
            id="mesh-member-rename-input"
            autoFocus
            value={value}
            maxLength={HOST_MESH_MAX_LABEL_CHARS}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                save()
              }
            }}
          />
          <p className="font-mono text-3xs text-muted-foreground">{member.hostKey}</p>
          {failure === 'invalid' ? (
            <p className="text-xs text-destructive">
              {t(
                'auto.components.settings.hostGroup.renameInvalid',
                'That name cannot be used. Pick a shorter name with at least one visible character.'
              )}
            </p>
          ) : failure === 'unreachable' ? (
            <p className="text-xs text-destructive">
              {t(
                'auto.components.settings.hostGroup.renameFailed',
                'Orca could not reach the mesh. Try again in a moment.'
              )}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {t('auto.components.settings.hostGroup.cancel', 'Cancel')}
          </Button>
          <Button type="button" disabled={busy || trimmed === ''} onClick={save}>
            {t('auto.components.settings.hostGroup.renameSave', 'Save name')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
