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
import { useTranslate } from '@/i18n/use-translate'
import { photonCalls, photonErrorMessage, usePhotonChannel } from '@/lib/photon-channel-client'
import type { Bot } from '../../../../../shared/bot-types'
import { isPhotonHandle } from '../../../../../shared/rpc-contract/bots-photon-params'
import type { PhotonChannelStatus } from '../../../../../shared/rpc-contract/bots-photon-params'
import { BotConnectorRowFrame } from '../BotConnectorRow'
import { BotConnectorCaption } from '../bot-connector-people'
import type { BotConnectorTitle } from '../bot-connector-titles'
import { PhotonConnectForm } from './PhotonConnectForm'
import { PhotonNoLineYet } from './PhotonNoLineYet'
import { PhotonSpectrumConnectForm } from './PhotonSpectrumConnectForm'
import { PhotonSpectrumLine } from './PhotonSpectrumLine'

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
          'Its number and key are gone. The record stays so its Photon project can still be deleted, and it can answer again on a Spectrum project you already run: connect that project’s id and secret. Giving it a Photon number again means deleting this project with `bots.photon.project.delete`, which burns the slug for good.'
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
                'Its numbers are released and its key is revoked. Giving it a Photon number again means deleting its project with `bots.photon.project.delete`, which burns the slug for good, so the record stays with only a project left; to keep it answering, point it at a Spectrum project you already run.'
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
  // Which way in the owner is taking when the account is not connected: Photon's own numbers, or a project
  // they already run. A Spectrum bot needs no account at all, so the second choice cannot be behind the
  // first — that was the dead end this replaces.
  const [ownProjectFirst, setOwnProjectFirst] = useState(false)
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
  // `assignment` is the only finished step: before it the record has a project but no number, so the
  // card must not say Connected and must send the owner to Repair. A bot on the owner's own Spectrum
  // project has no steps at all, because Orca did none of them.
  const ownProject = line?.mode === 'spectrum'
  // Either way in counts as connected: a bot on the owner's own Spectrum project answers with no Photon
  // account on this computer at all, so the account's own state cannot be the whole answer.
  const connected = channel?.connected === true || (line !== undefined && !line.released)
  const unfinished =
    line !== undefined && !line.released && !ownProject && line.completedThrough !== 'assignment'
  const notReceiving = line?.stream === 'deaf' || line?.stream === 'stopped'
  const description = !connected
    ? t('bots.photon.notConnected', 'Not set up yet: Photon provides the number.')
    : line === undefined
      ? t('bots.photon.noLine', 'Not connected to Photon.')
      : line.released
        ? t('bots.photon.released', 'Released')
        : ownProject
          ? t('bots.photon.spectrumRow', 'Answers on your own Spectrum project.')
          : unfinished
            ? t(
                'bots.photon.unfinished',
                'Set up only as far as {{step}}, so it has no number yet. Repair finishes it.',
                { step: line.completedThrough ?? 'project' }
              )
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
        connected && line && !line.released
          ? unfinished
            ? { label: t('bots.photon.needsYou', 'Needs you'), tone: 'attention' }
            : ownProject && line.secretMissing
              ? { label: t('bots.photon.needsYou', 'Needs you'), tone: 'attention' }
              : notReceiving
                ? { label: t('bots.photon.notReceiving', 'Not receiving'), tone: 'attention' }
                : { label: t('bots.photon.connected', 'Connected'), tone: 'connected' }
          : null
      }
      actions={{}}
    >
      {!connected ? (
        <div className="space-y-3">
          <p className="text-xs leading-5 text-muted-foreground">
            {ownProjectFirst
              ? t(
                  'bots.photon.spectrumNoAccount',
                  'A Spectrum project you already run needs no Photon account here: the project’s own id and secret are enough for this bot.'
                )
              : t(
                  'bots.photon.setupNote',
                  'Texting a bot needs an iMessage number, and Photon assigns it. Connect your own Photon account once on this computer; no Orca account is involved.'
                )}
          </p>
          {ownProjectFirst ? (
            <PhotonSpectrumConnectForm
              bot={bot}
              canSeal={channel?.accountKeySealed ?? false}
              onConnected={reload}
              onCancel={() => setOwnProjectFirst(false)}
            />
          ) : (
            <>
              <PhotonConnectForm
                hostId={bot.hostId}
                canSeal={channel?.accountKeySealed ?? false}
                onConnected={reload}
              />
              <Button size="xs" variant="ghost" onClick={() => setOwnProjectFirst(true)}>
                {t('bots.photon.spectrumUseExisting', 'Use an existing Spectrum project')}
              </Button>
            </>
          )}
        </div>
      ) : line === undefined ? (
        <PhotonNoLineYet
          bot={bot}
          hostId={bot.hostId}
          canSeal={channel?.accountKeySealed ?? false}
          onChanged={reload}
        />
      ) : line.mode === 'spectrum' ? (
        <PhotonSpectrumLine
          bot={bot}
          line={line}
          canSeal={channel?.accountKeySealed ?? false}
          onChanged={reload}
        />
      ) : (
        <PhotonLine bot={bot} hostId={bot.hostId} line={line} onChanged={reload} />
      )}
    </BotConnectorRowFrame>
  )
}
