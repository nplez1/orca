// Settings › Bots: connecting a Photon account once per computer. The key is the owner's, and keeping it
// is their choice — a host with no keyring can only use it for the session, which this says.
import React, { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTranslate } from '@/i18n/use-translate'
import { photonCalls, photonErrorMessage } from '@/lib/photon-channel-client'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'

/** Connect once per computer: the account key is the owner's, and storing it is their choice. */
export function PhotonConnectForm({
  hostId,
  canSeal,
  onConnected
}: {
  hostId: ExecutionHostId
  /** False when this host has no keyring: the key then cannot be written, only used for the session. */
  canSeal: boolean
  onConnected: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const organizationIdInput = useId()
  const accountKeyInput = useId()
  const storesKeyBox = useId()
  const [organizationId, setOrganizationId] = useState('')
  const [accountKey, setAccountKey] = useState('')
  const [storesKey, setStoresKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = organizationId.trim().length > 0 && accountKey.trim().length >= 8 && !busy
  const submit = (): void => {
    if (!ready) {
      return
    }
    setBusy(true)
    setError(null)
    void photonCalls(hostId)
      .connect({
        organizationId: organizationId.trim(),
        accountKey,
        storesKey: storesKey && canSeal
      })
      .then(
        () => {
          setAccountKey('')
          onConnected()
        },
        (caught: unknown) => {
          setAccountKey('')
          setError(
            photonErrorMessage(caught) ??
              t('bots.photon.connectFailed', 'Could not connect Photon on this computer.')
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
      <div className="space-y-1">
        <Label htmlFor={organizationIdInput} variant="settings">
          {t('bots.photon.organizationId', 'Photon organization ID')}
        </Label>
        <Input
          id={organizationIdInput}
          autoComplete="off"
          spellCheck={false}
          className="h-7 max-w-60"
          value={organizationId}
          onChange={(event) => setOrganizationId(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {t(
            'bots.photon.organizationIdHint',
            'From your Photon dashboard. Photon assigns the numbers; Orca asks it for one when a bot needs a line.'
          )}
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor={accountKeyInput} variant="settings">
          {t('bots.photon.accountKey', 'Account key')}
        </Label>
        <Input
          id={accountKeyInput}
          type="password"
          autoComplete="off"
          spellCheck={false}
          className="h-7 max-w-60"
          value={accountKey}
          onChange={(event) => setAccountKey(event.target.value)}
        />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={storesKeyBox}
          checked={storesKey && canSeal}
          disabled={!canSeal}
          onCheckedChange={(checked) => setStoresKey(checked === true)}
        />
        <Label htmlFor={storesKeyBox} variant="settings">
          {canSeal
            ? t(
                'bots.photon.storesKey',
                'Keep the key on this computer, sealed by its keyring. Otherwise it lasts this session.'
              )
            : t(
                'bots.photon.cannotStoreKey',
                'This computer has no keyring to seal a key with, so it is not written: the key lasts this session.'
              )}
        </Label>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" size="xs" disabled={!ready}>
        {t('bots.photon.connect', 'Connect Photon')}
      </Button>
    </form>
  )
}
