// Settings › a bot's Connectors › iMessage: pointing one bot at a Spectrum project the owner already
// runs, instead of letting Photon provision one for it. Nothing is created here, so this asks for the
// project's own id and secret and nothing else — and keeping the secret is the owner's choice, exactly as
// keeping the account key is.
import React, { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTranslate } from '@/i18n/use-translate'
import { photonCalls, photonErrorMessage } from '@/lib/photon-channel-client'
import type { Bot } from '../../../../../shared/bot-types'

/** The bot this connection is for, and where its settings live. */
export function PhotonSpectrumConnectForm({
  bot,
  canSeal,
  initialProjectId,
  submitLabel,
  onConnected,
  onCancel
}: {
  bot: Bot
  /** False when this host has no keyring: the secret then cannot be written, only used for the session. */
  canSeal: boolean
  /** The project this bot already reads, so rotating its secret does not mean pasting the id again. */
  initialProjectId?: string
  submitLabel?: string
  onConnected: () => void
  /** Absent when there is nothing to go back to: a bot whose secret is gone has to be reconnected. */
  onCancel?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const projectIdInput = useId()
  const projectSecretInput = useId()
  const storesSecretBox = useId()
  const [projectId, setProjectId] = useState(initialProjectId ?? '')
  const [projectSecret, setProjectSecret] = useState('')
  const [storesSecret, setStoresSecret] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = projectId.trim().length > 0 && projectSecret.trim().length >= 8 && !busy
  const submit = (): void => {
    if (!ready) {
      return
    }
    setBusy(true)
    setError(null)
    void photonCalls(bot.hostId)
      .connectSpectrum({
        botId: bot.id,
        projectId: projectId.trim(),
        projectSecret,
        storesSecret: storesSecret && canSeal
      })
      .then(
        () => {
          setProjectSecret('')
          onConnected()
        },
        (caught: unknown) => {
          // Never kept in the field either way: a refused secret is one to paste again, not one to read off
          // the screen while working out what went wrong.
          setProjectSecret('')
          setError(
            photonErrorMessage(caught) ??
              t(
                'bots.photon.spectrumConnectFailed',
                'Spectrum refused that project. Check the project id and its secret, then try again.'
              )
          )
        }
      )
      .finally(() => setBusy(false))
  }
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <p className="text-xs leading-5 text-muted-foreground">
        {t(
          'bots.photon.spectrumLead',
          'Point {{bot}} at a Spectrum project you already run. Nothing is created and no number is assigned here: its lines, and who may reach them, stay in Spectrum.',
          { bot: bot.name }
        )}
      </p>
      <div className="space-y-1">
        <Label htmlFor={projectIdInput} variant="settings">
          {t('bots.photon.spectrumProjectId', 'Spectrum project ID')}
        </Label>
        <Input
          id={projectIdInput}
          autoComplete="off"
          spellCheck={false}
          className="h-7 max-w-60"
          placeholder={t('bots.photon.spectrumProjectIdPlaceholder', 'pho_prj_…')}
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {t(
            'bots.photon.spectrumProjectIdHint',
            'From the project’s Settings page in Spectrum: the project’s own id, not the organization’s.'
          )}
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor={projectSecretInput} variant="settings">
          {t('bots.photon.spectrumProjectSecret', 'Project secret')}
        </Label>
        <Input
          id={projectSecretInput}
          type="password"
          autoComplete="off"
          spellCheck={false}
          className="h-7 max-w-60"
          value={projectSecret}
          onChange={(event) => setProjectSecret(event.target.value)}
        />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={storesSecretBox}
          checked={storesSecret && canSeal}
          disabled={!canSeal}
          onCheckedChange={(checked) => setStoresSecret(checked === true)}
        />
        <Label htmlFor={storesSecretBox} variant="settings">
          {canSeal
            ? t(
                'bots.photon.spectrumStoresSecret',
                'Keep the secret on this computer, sealed by its keyring. Otherwise it lasts this session.'
              )
            : t(
                'bots.photon.spectrumCannotStoreSecret',
                'This computer has no keyring to seal a secret with, so it is not written: the secret lasts this session.'
              )}
        </Label>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="xs" disabled={!ready}>
          {submitLabel ?? t('bots.photon.spectrumConnect', 'Connect this project')}
        </Button>
        {onCancel ? (
          <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={onCancel}>
            {t('bots.photon.notNow', 'Not now')}
          </Button>
        ) : null}
      </div>
    </form>
  )
}
