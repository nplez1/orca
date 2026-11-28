// The two steps a bot takes before it has a line: elect to connect it, then say whose number goes on its
// list. Nothing exists in Photon until the second step, because the owner asked for it. The other way in is
// a Spectrum project the owner already runs, which creates nothing at all — hence the second choice here.
import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTranslate } from '@/i18n/use-translate'
import { photonCalls, photonErrorMessage } from '@/lib/photon-channel-client'
import type { Bot } from '../../../../../shared/bot-types'
import { isPhotonHandle } from '../../../../../shared/rpc-contract/bots-photon-params'
import { PhotonSpectrumConnectForm } from './PhotonSpectrumConnectForm'

/** A bot with nothing in Photon yet. Connecting is the owner's call, so this asks before anything is
 *  created: the second step is where the project, the key and the first person on its list are made. */
export function PhotonNoLineYet({
  bot,
  hostId,
  canSeal,
  onChanged
}: {
  bot: Bot
  hostId: Bot['hostId']
  /** False when this host has no keyring, which decides whether a secret can be kept at all. */
  canSeal: boolean
  onChanged: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [handle, setHandle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [electing, setElecting] = useState(false)
  const [existingProject, setExistingProject] = useState(false)
  const ready = isPhotonHandle(handle) && !busy
  if (existingProject) {
    return (
      <PhotonSpectrumConnectForm
        bot={bot}
        canSeal={canSeal}
        onConnected={onChanged}
        onCancel={() => setExistingProject(false)}
      />
    )
  }
  if (!electing) {
    return (
      <div className="space-y-2">
        <p className="text-xs leading-5 text-muted-foreground">
          {t(
            'bots.photon.notYetAnywhere',
            '{{bot}} has nothing in Photon yet. Connecting makes it its own Photon agent, with its own key and its own number; Orca makes none of that until you ask.',
            { bot: bot.name }
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="xs" variant="outline" onClick={() => setElecting(true)}>
            {t('bots.photon.connectBot', 'Connect {{bot}} to Photon', { bot: bot.name })}
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={() => setExistingProject(true)}>
            {t('bots.photon.spectrumUseExisting', 'Use an existing Spectrum project')}
          </Button>
        </div>
      </div>
    )
  }
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (!ready) {
          return
        }
        setBusy(true)
        setError(null)
        void photonCalls(hostId)
          .createBot({ botId: bot.id, handle: handle.trim() })
          .then(
            () => {
              setHandle('')
              onChanged()
            },
            (caught: unknown) =>
              setError(
                photonErrorMessage(caught) ??
                  t('bots.photon.createFailed', 'Photon could not give {{bot}} a number.', {
                    bot: bot.name
                  })
              )
          )
          .finally(() => setBusy(false))
      }}
    >
      <Label htmlFor={`photon-handle-${bot.id}`} variant="settings">
        {t('bots.photon.ownerHandle', 'Your phone number or Apple ID')}
      </Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={`photon-handle-${bot.id}`}
          autoComplete="off"
          spellCheck={false}
          className="h-7 max-w-52"
          value={handle}
          aria-invalid={handle.trim().length > 0 && !isPhotonHandle(handle)}
          placeholder={t('bots.photon.handlePlaceholder', '+15551234567')}
          onChange={(event) => setHandle(event.target.value)}
        />
        <Button type="submit" size="xs" variant="outline" disabled={!ready}>
          {t('bots.photon.giveNumber', 'Connect and give it a number')}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setElecting(false)
            setHandle('')
            setError(null)
          }}
        >
          {t('bots.photon.notNow', 'Not now')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          'bots.photon.ownerHandleHint',
          'Required: you are the first person on {{bot}}’s list, and the only one who can text it until you add others. Photon assigns the number, so nobody buys one.',
          { bot: bot.name }
        )}
      </p>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  )
}
