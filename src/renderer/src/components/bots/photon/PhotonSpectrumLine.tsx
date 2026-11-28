// Settings › a bot's Connectors › iMessage, for a bot that answers on a Spectrum project the owner
// already runs. Orca created nothing here, so there is no number, no assignment list, no repair and no
// project to delete: this reads what happened and offers the two things that are Orca's to do — paste the
// secret again, and stop reading.
import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { photonCalls, photonErrorMessage } from '@/lib/photon-channel-client'
import type { Bot } from '../../../../../shared/bot-types'
import type { PhotonChannelStatus } from '../../../../../shared/rpc-contract/bots-photon-params'
import { PhotonSpectrumConnectForm } from './PhotonSpectrumConnectForm'

type PhotonBot = PhotonChannelStatus['bots'][number]

/** One bot's channel on the owner's own Spectrum project: what it reads, and letting go of it. */
export function PhotonSpectrumLine({
  bot,
  line,
  canSeal,
  onChanged
}: {
  bot: Bot
  line: PhotonBot
  canSeal: boolean
  onChanged: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmRelease, setConfirmRelease] = useState(false)
  const release = (): void => {
    setBusy(true)
    setError(null)
    void photonCalls(bot.hostId)
      .releaseBot({ botId: bot.id })
      .then(onChanged, (caught: unknown) =>
        setError(
          photonErrorMessage(caught) ?? t('bots.photon.changeFailed', 'Photon refused that change.')
        )
      )
      .finally(() => setBusy(false))
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {line.slug
          ? t(
              'bots.photon.spectrumAnswersOn',
              'Answers on your own Spectrum project “{{slug}}”. Its lines, and who may reach them, stay in Spectrum.',
              { slug: line.slug }
            )
          : t(
              'bots.photon.spectrumAnswersOnId',
              'Answers on your own Spectrum project {{projectId}}. Its lines, and who may reach them, stay in Spectrum.',
              { projectId: line.projectId }
            )}
      </p>
      {line.secretMissing ? (
        <p role="alert" className="text-xs text-destructive">
          {t(
            'bots.photon.spectrumSecretMissing',
            'Its project secret is not on this computer any more, because it was kept for one session only. Nothing reaches this bot until you paste it again.'
          )}
        </p>
      ) : null}
      {editing || line.secretMissing ? (
        <PhotonSpectrumConnectForm
          bot={bot}
          canSeal={canSeal}
          initialProjectId={line.projectId}
          submitLabel={t('bots.photon.spectrumPasteSecret', 'Save the secret')}
          onConnected={() => {
            setEditing(false)
            onChanged()
          }}
          {...(editing ? { onCancel: () => setEditing(false) } : {})}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="xs" variant="outline" disabled={busy} onClick={() => setEditing(true)}>
            {t('bots.photon.spectrumReplaceSecret', 'Replace the project secret')}
          </Button>
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => setConfirmRelease(true)}>
            {t('bots.photon.spectrumRelease', 'Stop reading this project')}
          </Button>
        </div>
      )}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <Dialog open={confirmRelease} onOpenChange={setConfirmRelease}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>
              {t('bots.photon.spectrumReleaseTitle', 'Stop reading {{bot}}’s project?', {
                bot: bot.name
              })}
            </DialogTitle>
            <DialogDescription>
              {t(
                'bots.photon.spectrumReleaseBody',
                'Orca stops reading the project and forgets the secret it kept. The project itself, its lines and everyone who can reach them are untouched: nothing of yours is released or deleted.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmRelease(false)}>
              {t('bots.photon.cancel', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => {
                setConfirmRelease(false)
                release()
              }}
            >
              {t('bots.photon.spectrumRelease', 'Stop reading this project')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
