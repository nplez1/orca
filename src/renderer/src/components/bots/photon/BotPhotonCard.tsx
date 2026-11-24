// Settings › a bot's Connectors: its iMessage line. Connect the owner's own Photon account, give the bot a
// number, and decide who may text it — all here, because that is where a connector is set up.
import React, { useState } from 'react'
import { MessageCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTranslate } from '@/i18n/use-translate'
import { photonCalls, photonErrorMessage, usePhotonChannel } from '@/lib/photon-channel-client'
import type { Bot } from '../../../../../shared/bot-types'
import { isPhotonHandle } from '../../../../../shared/rpc-contract/bots-photon-params'
import type { PhotonChannelStatus } from '../../../../../shared/rpc-contract/bots-photon-params'
import { BotConnectorRowFrame } from '../BotConnectorRow'
import { BotConnectorCaption } from '../bot-connector-people'
import type { BotConnectorTitle } from '../bot-connector-titles'
import { PhotonConnectForm } from './PhotonConnectForm'

type PhotonBot = PhotonChannelStatus['bots'][number]

/** What a repair said it fixed and could not; anything else is not a repair answer. */
function notesOf(result: unknown): string[] {
  if (typeof result !== 'object' || result === null || !('notes' in result)) {
    return []
  }
  const notes = result.notes
  return Array.isArray(notes) ? notes.filter((note) => typeof note === 'string') : []
}

/** One number, who may text it, the repairs, and letting go. */
function PhotonLine({
  bot,
  hostId,
  line,
  onChanged
}: {
  bot: Bot
  hostId: Bot['hostId']
  line: PhotonBot
  onChanged: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [handle, setHandle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState<readonly string[]>([])
  const [confirmRelease, setConfirmRelease] = useState(false)
  const run = (work: () => Promise<unknown>): void => {
    setBusy(true)
    setError(null)
    void work()
      .then(
        (result) => {
          setHandle('')
          setNotes(notesOf(result))
          onChanged()
        },
        (caught: unknown) => {
          setNotes([])
          setError(
            photonErrorMessage(caught) ??
              t('bots.photon.changeFailed', 'Photon refused that change.')
          )
        }
      )
      .finally(() => setBusy(false))
  }
  const release = (member: string): void => {
    run(() =>
      photonCalls(hostId)
        .releaseMember({ botId: bot.id, handle: member })
        .then((result) => {
          // Photon answers `released: false` for a handle it no longer has; that is not a success.
          if (result && typeof result === 'object' && 'released' in result && !result.released) {
            throw new Error(
              t('bots.photon.memberAlreadyGone', '{{handle}} was not on its list any more.', {
                handle: member
              })
            )
          }
          return result
        })
    )
  }
  if (line.released) {
    return (
      <p className="text-xs text-muted-foreground">
        {t(
          'bots.photon.releasedWhatLeft',
          'Its number and key are gone, and only the Photon project is left. Deleting that project in Photon does not clear the record here: giving this bot a number again needs `bots.photon.project.delete`, which Settings does not offer because it burns the slug for good.'
        )}
      </p>
    )
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {t(
          'bots.photon.itsOwnAgent',
          'Its own Photon agent, “{{slug}}”, with its own key and its own list of people. Photon gives one project per bot.',
          { slug: line.slug }
        )}
      </p>
      {line.handles.length > 0 ? (
        <div className="space-y-1">
          <BotConnectorCaption title={t('bots.photon.whoCanText', 'Who can text it')} />
          <ul className="space-y-1">
            {line.handles.map((member) => (
              <li key={member} className="flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 break-words">{member}</span>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  aria-label={t('bots.photon.removeMemberFor', 'Stop {{handle}} texting it', {
                    handle: member
                  })}
                  onClick={() => release(member)}
                >
                  {t('bots.photon.removeMember', 'Remove')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {line.unknownSenderCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'bots.photon.unknownSenders',
            '{{count}} messages from numbers it has no assignment for. Repair re-reads the assignment list from Photon.',
            { count: line.unknownSenderCount }
          )}
        </p>
      ) : null}
      {line.parkedMessageCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'bots.photon.parked',
            '{{count}} messages could not be delivered. Last reason: {{reason}}',
            {
              count: line.parkedMessageCount,
              reason: line.lastParkedReason ?? t('bots.photon.parkedUnknown', 'not recorded')
            }
          )}
        </p>
      ) : null}
      {line.undeliveredAnswerCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'bots.photon.undelivered',
            '{{count}} answers never arrived within its retry window. Last reason: {{reason}}',
            {
              count: line.undeliveredAnswerCount,
              reason: line.lastUndeliveredReason ?? t('bots.photon.parkedUnknown', 'not recorded')
            }
          )}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label={t('bots.photon.addHandle', 'Phone number or Apple ID to let text it')}
          autoComplete="off"
          spellCheck={false}
          className="h-7 max-w-52"
          value={handle}
          aria-invalid={handle.trim().length > 0 && !isPhotonHandle(handle)}
          placeholder={t('bots.photon.handlePlaceholder', '+15551234567')}
          onChange={(event) => setHandle(event.target.value)}
        />
        <Button
          size="xs"
          variant="outline"
          disabled={busy || !isPhotonHandle(handle)}
          onClick={() =>
            run(() => photonCalls(hostId).addMember({ botId: bot.id, handle: handle.trim() }))
          }
        >
          {t('bots.photon.addMember', 'Let them text it')}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() => run(() => photonCalls(hostId).reconcile(bot.id))}
        >
          {t('bots.photon.repair', 'Repair')}
        </Button>
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => setConfirmRelease(true)}>
          {t('bots.photon.releaseBot', 'Release the number')}
        </Button>
      </div>
      {notes.length > 0 ? (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {notes.map((note, index) => (
            <li key={`${index}:${note}`}>{note}</li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <Dialog open={confirmRelease} onOpenChange={setConfirmRelease}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>
              {t('bots.photon.releaseConfirmTitle', 'Release {{bot}}’s number?', { bot: bot.name })}
            </DialogTitle>
            <DialogDescription>
              {t(
                'bots.photon.releaseConfirmBody',
                'Its numbers are released and its key is revoked. Settings has no way back: giving it a number again means deleting its Photon project with `bots.photon.project.delete`, which burns the slug for good, so the record stays with only a project left.'
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
                run(() => photonCalls(hostId).releaseBot({ botId: bot.id }))
              }}
            >
              {t('bots.photon.releaseBot', 'Release the number')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** A bot with no number yet: give it one, and say who starts out able to text it. */
function NoLineYet({
  bot,
  hostId,
  onChanged
}: {
  bot: Bot
  hostId: Bot['hostId']
  onChanged: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [handle, setHandle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = isPhotonHandle(handle) && !busy
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
          {t('bots.photon.giveNumber', 'Give it a number')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          'bots.photon.ownerHandleHint',
          'Photon assigns the number, so nobody needs to buy one. This makes {{bot}} its own Photon agent, with its own list of people; your handle is the first on it.',
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

/** Settings › a bot's Connectors › iMessage: the whole channel for one bot, including the account. */
export function BotPhotonCard({
  bot,
  title
}: {
  bot: Bot
  title?: BotConnectorTitle
}): React.JSX.Element | null {
  const t = useTranslate()
  const { view, reload } = usePhotonChannel(bot.hostId)
  if (view.status === 'loading' || view.status === 'unavailable') {
    return null
  }
  const channel = view.status === 'ready' ? view.value : null
  const line = channel?.bots.find((entry) => entry.botId === bot.id)
  const name = title ?? { service: t('bots.photon.title', 'iMessage'), name: null }
  if (view.status === 'failed') {
    return (
      <BotConnectorRowFrame
        icon={<MessageCircle className="size-4" />}
        name={name}
        description={t('bots.photon.readFailed', 'Could not read the channel on this computer.')}
        status={{ label: t('bots.photon.needsYou', 'Needs you'), tone: 'attention' }}
        fix={{
          label: t('bots.photon.retry', 'Try again'),
          onClick: reload,
          opensRow: false
        }}
        actions={{}}
      >
        {photonErrorMessage(view.error) ?? null}
      </BotConnectorRowFrame>
    )
  }
  const description = !channel?.connected
    ? t('bots.photon.notConnected', 'Not set up yet: Photon provides the number.')
    : line === undefined
      ? t('bots.photon.noLine', 'No number yet.')
      : line.released
        ? t('bots.photon.released', 'Released')
        : t('bots.photon.answersOn', 'Answers on {{number}}.', {
            number:
              line.phoneNumber ?? t('bots.photon.numberPending', 'a number Photon is assigning')
          })
  return (
    <BotConnectorRowFrame
      icon={<MessageCircle className="size-4" />}
      name={name}
      description={description}
      status={
        channel?.connected && line && !line.released
          ? { label: t('bots.photon.connected', 'Connected'), tone: 'connected' }
          : null
      }
      actions={{}}
    >
      {!channel?.connected ? (
        <div className="space-y-3">
          <p className="text-xs leading-5 text-muted-foreground">
            {t(
              'bots.photon.setupNote',
              'Texting a bot needs an iMessage number, and Photon assigns it. Connect your own Photon account once on this computer; no Orca account is involved.'
            )}
          </p>
          <PhotonConnectForm
            hostId={bot.hostId}
            canSeal={channel?.accountKeySealed ?? false}
            onConnected={reload}
          />
        </div>
      ) : line === undefined ? (
        <NoLineYet bot={bot} hostId={bot.hostId} onChanged={reload} />
      ) : (
        <PhotonLine bot={bot} hostId={bot.hostId} line={line} onChanged={reload} />
      )}
    </BotConnectorRowFrame>
  )
}
