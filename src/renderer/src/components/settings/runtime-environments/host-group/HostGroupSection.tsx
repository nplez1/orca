import { useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { Translate } from '@/i18n/use-translate'
import { DEFAULT_HOST_MESH_SETTINGS } from '../../../../../../shared/host-mesh/host-mesh-admission'
import { Badge } from '../../../ui/badge'
import { Button } from '../../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../../ui/dialog'
import { LoadingSpinner } from '../../../ui/LoadingSpinner'
import { SettingsRow, SettingsSwitchRow } from '../../form-controls/SettingsFormControls'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import {
  hostGroupAutoSyncLine,
  hostGroupGroupLine,
  hostGroupMemberStatus,
  hostGroupMigrationLine,
  hostGroupSummaryLine
} from './host-group-copy'
import { useHostMeshSnapshot } from './host-mesh-shared-state'
import { useHostGroupSnapshot, type HostGroupFailure } from './use-host-group-snapshot'

/**
 * The mesh, as settings shows it: one switch, the group's state, and nothing duplicated.
 *
 * Why there is no member list here: every member is a host the owner already paired, so it is already a row in
 * the list above — with its own badge and its own Eject. A second list of the same machines made the owner read
 * one pairing twice and pick which copy to act on. The one exception is a member this computer cannot reach, which
 * has no row above and is the only thing this section still lists.
 */
export function HostGroupSection(): React.JSX.Element | null {
  const t = useTranslate()
  const group = useHostGroupSnapshot()
  const snapshot = useHostMeshSnapshot()
  const [confirmingLeave, setConfirmingLeave] = useState(false)

  if (!group.available) {
    return null
  }

  const settings = snapshot?.settings ?? DEFAULT_HOST_MESH_SETTINGS
  const busy = group.busy
  const failure = describeFailure(group.failure, t)
  const migrationLine = snapshot ? hostGroupMigrationLine(snapshot.migration, t) : null
  const autoSyncLine = snapshot ? hostGroupAutoSyncLine(snapshot, t) : null
  const unreachable = (snapshot?.members ?? []).filter((member) => member.environmentId === null)

  return (
    <SettingsGroup
      id="host-group"
      title={t('auto.components.settings.hostGroup.title', 'Host mesh')}
      description={t(
        'auto.components.settings.hostGroup.description',
        'Every computer in the mesh is paired with every other one, so each host lists the same workspaces.'
      )}
    >
      <SettingsSwitchRow
        label={t('auto.components.settings.hostGroup.meshMode', 'Mesh mode')}
        description={t(
          'auto.components.settings.hostGroup.meshModeDescription',
          'On, a computer you pair with is paired back and joined to the rest of the mesh, and this computer accepts the same from them. Off, it keeps only the pairings you make yourself. Either way a paired computer can run commands on this one.'
        )}
        checked={settings.enabled}
        disabled={snapshot === null || busy !== null}
        onChange={() => void group.updateSettings({ enabled: !settings.enabled })}
      />

      <div className="space-y-1 py-3">
        {snapshot ? (
          <p className="text-sm font-medium">{hostGroupSummaryLine(snapshot.summary, t)}</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('auto.components.settings.hostGroup.reading', 'Reading the mesh…')}
          </p>
        )}
        <p className="text-xs text-muted-foreground">{hostGroupGroupLine(settings, snapshot, t)}</p>
        {autoSyncLine ? <p className="text-xs text-muted-foreground">{autoSyncLine}</p> : null}
        {migrationLine ? <p className="text-xs text-muted-foreground">{migrationLine}</p> : null}
        {snapshot?.lastError ? (
          <p className="text-xs text-status-warning-text">{snapshot.lastError}</p>
        ) : null}
        {failure ? <p className="text-xs text-destructive">{failure}</p> : null}
      </div>

      {unreachable.length > 0 ? (
        <div className="border-t border-border">
          {unreachable.map((member) => {
            const status = hostGroupMemberStatus(member.status, t)
            return (
              <SettingsRow
                key={member.hostKey}
                label={member.label}
                labelAccessory={<Badge variant={status.tone}>{status.label}</Badge>}
                description={t(
                  'auto.components.settings.hostGroup.notReachable',
                  'This computer holds no way to reach it. It is picked up on its own once it is running and paired, or eject it.'
                )}
                control={
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={busy !== null}
                    onClick={() => void group.removeMember(member.hostKey)}
                  >
                    {t('auto.components.settings.hostGroup.eject', 'Eject')}
                  </Button>
                }
              />
            )
          })}
        </div>
      ) : null}

      {snapshot?.inGroup ? (
        <div className="flex justify-end border-t border-border py-3">
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={busy !== null}
            onClick={() => setConfirmingLeave(true)}
          >
            {t('auto.components.settings.hostGroup.leaveGroup', 'Leave mesh')}
          </Button>
        </div>
      ) : null}

      <Dialog
        open={confirmingLeave}
        onOpenChange={(open) => {
          if (!open && busy === null) {
            setConfirmingLeave(false)
          }
        }}
      >
        <DialogContent className="max-w-sm sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {t('auto.components.settings.hostGroup.leaveTitle', 'Leave the mesh')}
            </DialogTitle>
            <DialogDescription>
              {t(
                'auto.components.settings.hostGroup.leaveDescription',
                'This computer leaves the group and drops its pairings with the members: each one is told, and this computer forgets the reach in both directions. Pairings with machines outside the group are untouched.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={() => setConfirmingLeave(false)}
            >
              {t('auto.components.settings.hostGroup.cancel', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={busy !== null}
              onClick={() => {
                void group.leave().then(() => setConfirmingLeave(false))
              }}
            >
              {busy === 'leave' ? <LoadingSpinner className="size-3" /> : null}
              {t('auto.components.settings.hostGroup.leaveConfirm', 'Leave mesh')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  )
}

function describeFailure(failure: HostGroupFailure | null, t: Translate): string | null {
  switch (failure) {
    case 'unavailable':
      return t(
        'auto.components.settings.hostGroup.unavailable',
        'This build cannot reach the host mesh.'
      )
    case 'invalid-request':
      return t(
        'auto.components.settings.hostGroup.invalidRequest',
        'Orca sent the mesh an incomplete request.'
      )
    case 'action-failed':
      return t(
        'auto.components.settings.hostGroup.actionFailed',
        'Orca couldn’t reach the mesh. It retries on its own in a moment.'
      )
    case null:
      return null
  }
}
