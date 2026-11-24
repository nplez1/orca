// Settings › Bots: the iMessage channel a computer's bots answer on, and who may text which bot. Optional:
// Photon provides the numbers, so this needs a Photon account and never an Orca one.
import React from 'react'
import { Button } from '@/components/ui/button'
import { SettingsSubsectionHeader } from '@/components/settings/form-controls/SettingsFormControls'
import { useTranslate } from '@/i18n/use-translate'
import { useHostBots } from '@/lib/bot-catalog'
import { photonErrorMessage, usePhotonChannel } from '@/lib/photon-channel-client'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { PhotonBotLine } from './PhotonBotLine'
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
  const bots = useHostBots(hostId)
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
              'Optional. Text the bots on {{host}}, through your own Photon account.',
              { host: hostName }
            )
          : t(
              'bots.photon.description',
              'Optional. Text your bots, through your own Photon account. Orca needs no account for it.'
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
              t('bots.photon.readFailed', 'Could not read the iMessage channel on this computer.')}
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
                  'Connected, and the stored key is only base64: this host has no keyring to seal it.'
                )
            : t('bots.photon.connectedSession', 'Connected for this session only.')}
        </p>
        <Button size="xs" variant="outline" onClick={reload}>
          {t('bots.photon.refresh', 'Refresh')}
        </Button>
      </div>
      <ul className="divide-y divide-border rounded-md border border-border">
        {bots.map((bot) => (
          <PhotonBotLine
            key={bot.id}
            hostId={hostId}
            bot={bot}
            line={channel.bots.find((entry) => entry.botId === bot.id)}
            onChanged={reload}
          />
        ))}
      </ul>
    </section>
  )
}
