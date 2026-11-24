// Settings › Bots: the iMessage channel a computer's bots answer on, and who may text which bot. Optional:
// Photon provides the numbers, so this needs a Photon account and never an Orca one.
import React from 'react'
import { Button } from '@/components/ui/button'
import { SettingsSubsectionHeader } from '@/components/settings/form-controls/SettingsFormControls'
import { useTranslate } from '@/i18n/use-translate'
import { photonErrorMessage, usePhotonChannel } from '@/lib/photon-channel-client'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { PhotonConnectForm } from './PhotonConnectForm'

/**
 * Settings › Bots: the iMessage channel a computer's bots answer on. Optional — Photon provides the
 * numbers, so this needs a Photon account and never an Orca one.
 */
export function PhotonChannelSettings({
  hostId,
  hostName
}: {
  hostId: ExecutionHostId
  hostName: string | null
}): React.JSX.Element | null {
  const t = useTranslate()
  const { view, reload } = usePhotonChannel(hostId)
  if (view.status === 'loading' || view.status === 'unavailable') {
    return null
  }
  const channel = view.status === 'ready' ? view.value : null
  const header = (
    <SettingsSubsectionHeader
      title={t('bots.photon.title', 'iMessage')}
      description={
        hostName
          ? t(
              'bots.photon.descriptionOnHost',
              'Optional. The Photon account the bots on {{host}} get their iMessage numbers from.',
              { host: hostName }
            )
          : t(
              'bots.photon.description',
              'Optional. The Photon account your bots’ iMessage numbers come from. Orca needs no account for it.'
            )
      }
    />
  )
  if (view.status === 'failed') {
    return (
      <section className="space-y-3">
        {header}
        <div className="flex items-center gap-3">
          <p role="alert" className="min-w-0 flex-1 text-xs text-destructive">
            {photonErrorMessage(view.error) ??
              t(
                'bots.photon.readFailedAccount',
                'Could not read the iMessage account on this computer.'
              )}
          </p>
          <Button size="xs" variant="outline" onClick={reload}>
            {t('bots.photon.retry', 'Try again')}
          </Button>
        </div>
      </section>
    )
  }
  if (!channel?.connected) {
    return (
      <section className="space-y-3">
        {header}
        <PhotonConnectForm
          hostId={hostId}
          canSeal={channel?.accountKeySealed ?? false}
          onConnected={reload}
        />
      </section>
    )
  }
  return (
    <section className="space-y-3">
      {header}
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          {channel.accountKeyStored
            ? channel.accountKeySealed
              ? t(
                  'bots.photon.connectedSealed',
                  'Connected, and the key is sealed on this computer.'
                )
              : t(
                  'bots.photon.connectedUnsealed',
                  'Connected, and a key is kept here, but this host cannot seal one now: it may need pasting again after a restart.'
                )
            : t('bots.photon.connectedSession', 'Connected for this session only.')}
        </p>
        <Button size="xs" variant="outline" onClick={reload}>
          {t('bots.photon.refresh', 'Refresh')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          'bots.photon.giveNumbersInBot',
          'A number and who may text it belong to one bot: open the bot and use its Connectors › iMessage.'
        )}
      </p>
    </section>
  )
}
