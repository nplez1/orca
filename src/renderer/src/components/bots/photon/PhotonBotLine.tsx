// Settings › Bots: one bot's iMessage line — its number, who may text it, the repairs, and letting go.
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
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'
import { photonCalls, photonErrorMessage } from '@/lib/photon-channel-client'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { isPhotonHandle } from '../../../../../shared/rpc-contract/bots-photon-params'
import type { PhotonChannelStatus } from '../../../../../shared/rpc-contract/bots-photon-params'

type PhotonBot = PhotonChannelStatus['bots'][number]

/** What a repair said it fixed and could not; anything else is not a repair answer. */
function notesOf(result: unknown): string[] {
  if (typeof result !== 'object' || result === null || !('notes' in result)) {
    return []
  }
  const notes = result.notes
  return Array.isArray(notes) ? notes.filter((note) => typeof note === 'string') : []
}

/** One number, who may text it, and the repairs — per bot. */
export function PhotonBotLine({
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
  return (
    <li className="space-y-2 px-3 py-2.5">
      <div className="flex items-center gap-3 text-sm">
        <span className="min-w-0 flex-1">{bot.name}</span>
        <span className="text-xs text-muted-foreground">
          {line === undefined
            ? t('bots.photon.noLine', 'No number')
            : line.released
              ? t('bots.photon.released', 'Released')
              : `${line.phoneNumber ?? t('bots.photon.numberPending', 'number pending')} · ${line.stream}`}
        </span>
      </div>
      {line?.released ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'bots.photon.releasedWhatLeft',
            'Its number and key are gone, and only the Photon project is left. Deleting that project in Photon does not clear the record here: giving this bot a number again needs `bots.photon.project.delete`, which Settings does not offer because it burns the slug for good.'
          )}
        </p>
      ) : null}
      {line && !line.released ? (
        <>
          {line.handles.length > 0 ? (
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
          ) : (
            <p className="text-xs text-muted-foreground">
              {t('bots.photon.noHandles', 'Nobody may text it yet.')}
            </p>
          )}
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
                  reason:
                    line.lastUndeliveredReason ?? t('bots.photon.parkedUnknown', 'not recorded')
                }
              )}
            </p>
          ) : null}
        </>
      ) : null}
      {line?.released ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={t('bots.photon.handle', 'Phone number or Apple ID')}
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
              run(() =>
                line
                  ? photonCalls(hostId).addMember({ botId: bot.id, handle: handle.trim() })
                  : photonCalls(hostId).createBot({ botId: bot.id, handle: handle.trim() })
              )
            }
          >
            {line
              ? t('bots.photon.addMember', 'Let them text it')
              : t('bots.photon.giveNumber', 'Give it a number')}
          </Button>
          {line ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => run(() => photonCalls(hostId).reconcile(bot.id))}
            >
              {t('bots.photon.repair', 'Repair')}
            </Button>
          ) : null}
          {line ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirmRelease(true)}
            >
              {t('bots.photon.releaseBot', 'Release the number')}
            </Button>
          ) : null}
        </div>
      )}
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
              {t('bots.photon.releaseConfirmTitle', 'Release {{bot}}’s number?', {
                bot: bot.name
              })}
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
    </li>
  )
}
