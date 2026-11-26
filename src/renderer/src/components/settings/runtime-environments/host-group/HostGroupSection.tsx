import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { Translate } from '@/i18n/use-translate'
import type { HostMeshMemberView } from '../../../../../../preload/api/host-mesh-api'
import {
  DEFAULT_HOST_MESH_SETTINGS,
  type HostMeshSettings
} from '../../../../../../shared/host-mesh/host-mesh-admission'
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
import { SettingsGroup, SettingsGroupSubsection } from '../../section-layout/SettingsGroup'
import {
  hostGroupCapacityNote,
  hostGroupMigrationLine,
  hostGroupGroupLine,
  hostGroupMemberDetail,
  hostGroupMemberStatus,
  hostGroupSummaryLine
} from './host-group-copy'
import { useHostGroupSnapshot, type HostGroupFailure } from './use-host-group-snapshot'

/**
 * The group, as the settings pane shows it.
 *
 * Why a member row reports `half` instead of hiding it: a one-way pairing is a real state — one machine
 * lists the other's workspaces and the other does not — and it is the state an owner has to fix.
 */
export function HostGroupSection(): React.JSX.Element | null {
  const t = useTranslate()
  const group = useHostGroupSnapshot()
  const [pendingEject, setPendingEject] = useState<HostMeshMemberView | null>(null)
  const [confirmingLeave, setConfirmingLeave] = useState(false)

  if (!group.available) {
    return null
  }

  const snapshot = group.snapshot
  const members = snapshot?.members ?? []
  const settings = snapshot?.settings ?? DEFAULT_HOST_MESH_SETTINGS
  const busy = group.busy
  const busyAction = busy !== null && busy !== 'read'
  const failure = describeFailure(group.failure, t)
  const capacityNote = snapshot ? hostGroupCapacityNote(snapshot.summary, t) : null
  const migrationLine = snapshot ? hostGroupMigrationLine(snapshot.migration, t) : null

  const updateSetting = (patch: Partial<HostMeshSettings>): void => {
    void group.updateSettings(patch)
  }

  return (
    <SettingsGroup
      id="host-group"
      title={t('auto.components.settings.hostGroup.title', 'Host group')}
      description={t(
        'auto.components.settings.hostGroup.description',
        'Pairing with one member of a group pairs this computer with all of them, so every host lists the same workspaces.'
      )}
      action={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => void group.sync()}
        >
          {busy === 'sync' ? (
            <LoadingSpinner className="size-3" />
          ) : (
            <RefreshCw className="size-3" />
          )}
          {t('auto.components.settings.hostGroup.syncNow', 'Sync now')}
        </Button>
      }
    >
      <div className="space-y-1 py-3">
        {snapshot ? (
          <p className="text-sm font-medium">{hostGroupSummaryLine(snapshot.summary, t)}</p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {snapshot
            ? hostGroupGroupLine(snapshot, t)
            : t('auto.components.settings.hostGroup.reading', 'Reading the group…')}
        </p>
        {migrationLine ? <p className="text-xs text-muted-foreground">{migrationLine}</p> : null}
        {capacityNote ? <p className="text-xs text-muted-foreground">{capacityNote}</p> : null}
        {snapshot?.lastError ? (
          <p className="text-xs text-status-warning-text">{snapshot.lastError}</p>
        ) : null}
        {failure ? <p className="text-xs text-destructive">{failure}</p> : null}
      </div>

      {members.map((member) => {
        const status = hostGroupMemberStatus(member.status, t)
        return (
          <SettingsRow
            key={member.hostKey}
            label={member.label}
            labelAccessory={<Badge variant={status.tone}>{status.label}</Badge>}
            description={hostGroupMemberDetail(member, members, t)}
            control={
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={busy !== null}
                aria-label={t('auto.components.settings.hostGroup.ejectMember', 'Eject {{name}}', {
                  name: member.label
                })}
                onClick={() => setPendingEject(member)}
              >
                {t('auto.components.settings.hostGroup.eject', 'Eject')}
              </Button>
            }
          />
        )
      })}

      {snapshot?.inGroup ? (
        <div className="flex justify-end border-t border-border py-3">
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={busy !== null}
            onClick={() => setConfirmingLeave(true)}
          >
            {t('auto.components.settings.hostGroup.leaveGroup', 'Leave group')}
          </Button>
        </div>
      ) : null}

      <SettingsGroupSubsection
        title={t('auto.components.settings.hostGroup.joining', 'Joining')}
        description={t(
          'auto.components.settings.hostGroup.joiningDescription',
          'What this computer does when a member adds another machine to the group.'
        )}
      >
        <SettingsSwitchRow
          label={t(
            'auto.components.settings.hostGroup.allowJoins',
            'Allow this computer to be added to a group'
          )}
          description={t(
            'auto.components.settings.hostGroup.allowJoinsDescription',
            'Off, another computer cannot put this one into a group at all, even one you have paired with. Turn it on for each computer you want to join.'
          )}
          checked={settings.allowJoins}
          disabled={snapshot === null || busy !== null}
          onChange={() => updateSetting({ allowJoins: !settings.allowJoins })}
        />
        <SettingsSwitchRow
          label={t(
            'auto.components.settings.hostGroup.autoAccept',
            'Auto-accept introduced members'
          )}
          description={t(
            'auto.components.settings.hostGroup.autoAcceptDescription',
            'Anyone the group’s members add is paired with this computer without asking, and can then run commands on it.'
          )}
          checked={settings.autoAcceptIntroducedMembers}
          disabled={snapshot === null || busy !== null}
          onChange={() =>
            updateSetting({
              autoAcceptIntroducedMembers: !settings.autoAcceptIntroducedMembers
            })
          }
        />
        <SettingsSwitchRow
          label={t(
            'auto.components.settings.hostGroup.acceptIntroductions',
            'Accept introductions'
          )}
          description={t(
            'auto.components.settings.hostGroup.acceptIntroductionsDescription',
            'Let a member pair this computer with a machine it vouches for. Off leaves this computer with the pairings you make yourself.'
          )}
          checked={settings.acceptIntroductions}
          disabled={snapshot === null || busy !== null}
          onChange={() => updateSetting({ acceptIntroductions: !settings.acceptIntroductions })}
        />
        <SettingsSwitchRow
          label={t('auto.components.settings.hostGroup.relayIntroductions', 'Relay introductions')}
          description={t(
            'auto.components.settings.hostGroup.relayIntroductionsDescription',
            'Forward a newcomer’s offers to the other members, so it does not have to reach each one itself.'
          )}
          checked={settings.relayIntroductions}
          disabled={snapshot === null || busy !== null}
          onChange={() => updateSetting({ relayIntroductions: !settings.relayIntroductions })}
        />
      </SettingsGroupSubsection>

      <Dialog
        open={pendingEject !== null}
        onOpenChange={(open) => {
          if (!open && !busyAction) {
            setPendingEject(null)
          }
        }}
      >
        <DialogContent className="max-w-sm sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {t('auto.components.settings.hostGroup.ejectTitle', 'Eject member')}
            </DialogTitle>
            <DialogDescription>
              {t(
                'auto.components.settings.hostGroup.ejectDescription',
                'This computer forgets the pairing in both directions and tells the member to drop it. The member keeps its own copy of the group.'
              )}
            </DialogDescription>
          </DialogHeader>
          {pendingEject ? (
            <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
              <div className="truncate font-medium">{pendingEject.label}</div>
              <div className="mt-0.5 truncate font-mono text-muted-foreground">
                {pendingEject.hostKey}
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={() => setPendingEject(null)}
            >
              {t('auto.components.settings.hostGroup.cancel', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={busy !== null}
              onClick={() => {
                const member = pendingEject
                if (member) {
                  void group.removeMember(member.hostKey).then(() => setPendingEject(null))
                }
              }}
            >
              {busy === 'remove' ? <LoadingSpinner className="size-3" /> : null}
              {t('auto.components.settings.hostGroup.ejectConfirm', 'Eject')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmingLeave}
        onOpenChange={(open) => {
          if (!open && !busyAction) {
            setConfirmingLeave(false)
          }
        }}
      >
        <DialogContent className="max-w-sm sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {t('auto.components.settings.hostGroup.leaveTitle', 'Leave group')}
            </DialogTitle>
            <DialogDescription>
              {t(
                'auto.components.settings.hostGroup.leaveDescription',
                'This computer stops listing the group’s members and leaves the group. The pairings with each member stay, and every member keeps its own copy of the group.'
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
              {t('auto.components.settings.hostGroup.leaveConfirm', 'Leave group')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  )
}

function describeFailure(failure: HostGroupFailure | null, t: Translate): string | null {
  if (failure === null) {
    return null
  }
  switch (failure) {
    case 'unavailable':
      return t(
        'auto.components.settings.hostGroup.unavailable',
        'This build cannot reach the host group.'
      )
    case 'invalid-request':
      return t(
        'auto.components.settings.hostGroup.invalidRequest',
        'Orca sent the group an incomplete request.'
      )
    case 'action-failed':
      return t(
        'auto.components.settings.hostGroup.actionFailed',
        'Orca couldn’t reach the group. Try Sync now.'
      )
  }
}
