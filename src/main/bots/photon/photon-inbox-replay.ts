// What the inbox holds and nothing ever dealt with, replayed: the crash recovery the inbox exists for, and
// the mail a paused bot held. Split from the service because it is one pass over the fleet at startup and
// one per bot on resume, and neither of them connects, provisions or changes anything.
import type { PhotonInbound } from './photon-inbound'
import type { PhotonInbox } from './photon-inbox'
import type { PhotonStore } from './photon-store'

export type PhotonInboxReplayDeps = {
  store: PhotonStore
  inbox: PhotonInbox
  inbound: PhotonInbound
  log?: (message: string, ...rest: unknown[]) => void
}

/** Replays what Orca wrote down and never dealt with, for every bot: run at startup, because that is when
 *  a crash is discovered. */
export async function replayPhotonPending(deps: PhotonInboxReplayDeps): Promise<void> {
  for (const record of await deps.store.bots()) {
    await replayPhotonBot(deps, record.botId)
  }
}

/** Replays a live bot's unhandled messages; a released one has none to replay. Parked messages come back
 *  first: a restart is when whatever made one undeliverable may have changed, and nothing else would ever
 *  ask again — a parked entry is marked handled, so `unhandled()` skips it. */
export async function replayPhotonBot(deps: PhotonInboxReplayDeps, botId: string): Promise<void> {
  const log = deps.log ?? ((message: string, ...rest: unknown[]) => console.warn(message, ...rest))
  const record = await deps.store.bot(botId)
  if (!record || record.released) {
    return
  }
  const unparked = await deps.inbox.unpark(record.projectId)
  if (unparked > 0) {
    log('[photon] giving', unparked, 'parked message(s) another chance')
  }
  void deps.inbound
    .recover({ botId, projectId: record.projectId })
    .catch((error: unknown) => log('[photon] could not replay held messages', error))
}
