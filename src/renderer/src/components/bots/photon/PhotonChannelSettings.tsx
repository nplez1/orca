// Settings › Bots: the iMessage channel, so a bot can be texted. Optional and off until an owner connects
// their own Photon account; nothing here needs Orca Cloud or an Orca account.
import React, { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SettingsSubsectionHeader } from '@/components/settings/form-controls/SettingsFormControls'
import { useTranslate } from '@/i18n/use-translate'
import { useHostBots } from '@/lib/bot-catalog'
import { photonCalls, photonErrorMessage, usePhotonChannel } from '@/lib/photon-channel-client'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { PhotonChannelStatus } from '../../../../../shared/rpc-contract/bots-photon-params'

type PhotonBot = PhotonChannelStatus['bots'][number]

/** Connect once per computer: the account key is the owner's, and storing it is their choice. */
function ConnectForm({
  hostId,
  onConnected
}: {
  hostId: ExecutionHostId
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
      .connect({ organizationId: organizationId.trim(), accountKey, storesKey })
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
            'From your Photon dashboard. Photon assigns the numbers; Orca only asks it for one per bot.'
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
          checked={storesKey}
          onCheckedChange={(checked) => setStoresKey(checked === true)}
        />
        <Label htmlFor={storesKeyBox} variant="settings">
          {t(
            'bots.photon.storesKey',
            'Keep the key on this computer, sealed by its keyring. Otherwise it lasts this session.'
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

function handleInputError(handle: string): boolean {
  return (
    handle.trim().length > 0 && !(handle.includes('@') || /^\+?[0-9][0-9 ().-]{4,}$/.test(handle))
  )
}

/** One number, who may text it, and the repairs — per bot. */
function BotLine({
  hostId,
  bot,
  line,
  onChanged
}: {
  hostId: ExecutionHostId
  bot: { id: string; name: string }
  line: PhotonBot | undefined
  onChanged: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const handleInput = useId()
  const [handle, setHandle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = (work: () => Promise<unknown>): void => {
    setBusy(true)
    setError(null)
    void work()
      .then(
        () => {
          setHandle('')
          onChanged()
        },
        (caught: unknown) =>
          setError(
            photonErrorMessage(caught) ??
              t('bots.photon.changeFailed', 'Photon refused that change.')
          )
      )
      .finally(() => setBusy(false))
  }
  const releasesAt = line?.released === true
  return (
    <li className="space-y-2 px-3 py-2.5">
      <div className="flex items-center gap-3 text-sm">
        <span className="min-w-0 flex-1">{bot.name}</span>
        <span className="text-xs text-muted-foreground">
          {line === undefined
            ? t('bots.photon.noLine', 'No number')
            : releasesAt
              ? t('bots.photon.released', 'Released')
              : `${line.phoneNumber ?? t('bots.photon.numberPending', 'number pending')} · ${line.stream}`}
        </span>
      </div>
      {line && !releasesAt ? (
        <>
          <p className="text-xs break-words text-muted-foreground">
            {line.handles.length > 0
              ? line.handles.join(', ')
              : t('bots.photon.noHandles', 'Nobody may text it yet.')}
          </p>
          {line.unknownSenderCount > 0 || line.parkedMessageCount > 0 ? (
            <p role="alert" className="text-xs text-destructive">
              {t(
                'bots.photon.drift',
                '{{unknown}} messages from numbers it has no assignment for, and {{parked}} it could not deliver. Repair re-reads the assignment list.',
                { unknown: line.unknownSenderCount, parked: line.parkedMessageCount }
              )}
            </p>
          ) : null}
        </>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label={t('bots.photon.handle', 'Phone number or Apple ID')}
          id={handleInput}
          autoComplete="off"
          spellCheck={false}
          className="h-7 max-w-52"
          value={handle}
          aria-invalid={handleInputError(handle)}
          placeholder={t('bots.photon.handlePlaceholder', '+15551234567')}
          onChange={(event) => setHandle(event.target.value)}
        />
        <Button
          size="xs"
          variant="outline"
          disabled={busy || handleInputError(handle) || handle.trim().length === 0}
          onClick={() =>
            run(() =>
              line && !releasesAt
                ? photonCalls(hostId).addMember({ botId: bot.id, handle: handle.trim() })
                : photonCalls(hostId).createBot({ botId: bot.id, handle: handle.trim() })
            )
          }
        >
          {line && !releasesAt
            ? t('bots.photon.addMember', 'Let them text it')
            : t('bots.photon.giveNumber', 'Give it a number')}
        </Button>
        {line && !releasesAt ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => run(() => photonCalls(hostId).reconcile(bot.id))}
          >
            {t('bots.photon.repair', 'Repair')}
          </Button>
        ) : null}
        {line && !releasesAt ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => run(() => photonCalls(hostId).releaseBot({ botId: bot.id }))}
          >
            {t('bots.photon.releaseBot', 'Release the number')}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  )
}

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
  const channel = view.status === 'ready' ? view.channel : null
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
        <ConnectForm hostId={hostId} onConnected={reload} />
      </section>
    )
  }
  return (
    <section className="space-y-3">
      {header}
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          {channel.accountKeyStored
            ? t('bots.photon.connectedStored', 'Connected, and the key stays on this computer.')
            : t('bots.photon.connectedSession', 'Connected for this session only.')}
          {channel.accountKeySealed
            ? null
            : ` ${t('bots.photon.notSealed', 'This computer cannot seal a key, so it is not kept.')}`}
        </p>
        <Button size="xs" variant="outline" onClick={reload}>
          {t('bots.photon.refresh', 'Refresh')}
        </Button>
      </div>
      <ul className="divide-y divide-border rounded-md border border-border">
        {bots.map((bot) => (
          <BotLine
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
