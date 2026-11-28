// One Spectrum channel per bot, and the tick that keeps them running. The same shape `PhotonStreams` has
// for the Socket.IO path, for the same reason: the channel is the only long-lived state this credential
// mode owns, so a stream that ended by itself is replaced rather than returned dead.
//
// What this does not share with `PhotonStreams` is the transport. A Spectrum project streams to this
// process over the SDK, so there is no Socket.IO socket and no server-side cursor to resume — the cursor
// here is this computer's own numbering, used only so a crash between the inbox write and the dispatch
// can be replayed in order. What it does share is the same inbound handler, the same inbox and the same
// outbox, which is what makes an inbound Spectrum message land in a bot's chat exactly as an inbound
// Socket.IO frame does.
import type { PhotonCursorStore } from './photon-cursor'
import type { PhotonInbound } from './photon-inbound'
import type { PhotonSendTransport } from './photon-send'
import {
  PhotonSpectrumChannel,
  type SpectrumAppFactory,
  type SpectrumApp
} from './photon-spectrum-channel'
import type { PhotonSpectrumSecrets } from './photon-spectrum-secrets'
import type { PhotonStore } from './photon-store'

/** A client opened for a channel that is not going to be kept: closed, and a failure to close it logged
 *  rather than thrown, because the caller is already reporting a channel it did not publish. */
async function stopQuietly(
  app: SpectrumApp,
  log: (message: string, ...rest: unknown[]) => void
): Promise<void> {
  await app.stop().catch((error: unknown) => {
    log('[photon] could not close an unclaimed Spectrum stream', error)
  })
}

/** The one thing this registry asks of the send path: retry what is queued for a bot. A Spectrum bot has
 *  no project key to pass, so the credential is deliberately absent from this slice. */
type PhotonSpectrumSendRetry = {
  retryPending(botId: string, credential: null): Promise<unknown>
}

/** The one thing this registry asks of the inbound adapter: take a message at a position, and say how it
 *  went. A test gives it only that. */
type PhotonSpectrumInbound = {
  handle(input: Parameters<PhotonInbound['handle']>[0]): Promise<unknown>
}

/** The one thing it asks of the inbox: the highest position this project already holds, so numbering can
 *  continue after a restart instead of repeating. */
type PhotonSpectrumSeqSource = {
  highestSeq(projectId: string): Promise<number>
}

export type PhotonSpectrumChannelsDeps = {
  store: PhotonStore
  cursors: PhotonCursorStore
  secrets: PhotonSpectrumSecrets
  inbound: PhotonSpectrumInbound
  /** Where the positions its own numbering hands out are already written. */
  inbox: PhotonSpectrumSeqSource
  sendPath: PhotonSpectrumSendRetry
  /** Opens the SDK for one bot. Production is `photonSpectrumApp`; a test supplies a fake. */
  createApp: SpectrumAppFactory
  log?: (message: string, ...rest: unknown[]) => void
}

export class PhotonSpectrumChannels {
  private readonly channels = new Map<string, PhotonSpectrumChannel>()
  /** Bots something asked to stop while their start was still opening. The record forget that follows a
   *  release takes longer than a client does to open, so the record alone cannot say "do not publish". */
  private readonly stopped = new Set<string>()
  private readonly log: (message: string, ...rest: unknown[]) => void

  constructor(private readonly deps: PhotonSpectrumChannelsDeps) {
    this.log = deps.log ?? ((message, ...rest) => console.warn(message, ...rest))
  }

  /** Follows every bot whose record names an existing Spectrum project. A bot with none is skipped
   *  rather than reported: most bots have no channel of this kind. */
  async startAll(): Promise<void> {
    for (const record of await this.deps.store.bots()) {
      if (record.mode === 'spectrum' && !record.released) {
        await this.start(record.botId)
      }
    }
  }

  /** Starts one bot's channel, or returns the live one. Null when the bot has no Spectrum project, its
   *  secret cannot be opened here, or the SDK refused to start — all of which are reports, not throws:
   *  the record and the secret are real either way, and a connect that saved them did not fail. */
  async start(botId: string): Promise<PhotonSpectrumChannel | null> {
    // A start is an explicit request to read this bot's project, so it takes the bot off the stopped list;
    // a stop that arrives from here on is recorded again by `stop`, and checked before publishing.
    this.stopped.delete(botId)
    const running = this.channels.get(botId)
    if (running?.live) {
      return running
    }
    // A channel whose stream ended still owns an SDK client, so it is closed before it is replaced
    // rather than dropped from the map while its socket is open.
    running?.stop()
    this.channels.delete(botId)
    const record = await this.deps.store.bot(botId)
    if (!record || record.mode !== 'spectrum' || record.released) {
      return null
    }
    const stored = await this.deps.secrets.secret(botId)
    if (!stored || stored.projectId !== record.projectId) {
      this.log('[photon] a Spectrum project secret is missing for bot', botId)
      return null
    }
    let app: SpectrumApp
    try {
      app = await this.deps.createApp({
        projectId: record.projectId,
        projectSecret: stored.secret
      })
    } catch (error) {
      this.log('[photon] could not open a Spectrum stream for bot', botId, error)
      return null
    }
    // The SDK opened while this was awaiting, and either a release ran or a reconnect re-pointed the bot.
    // Either way this client is not the one to keep: it was opened with credentials the record no longer
    // names, and it is closed instead of being published, because a channel nothing references is a socket
    // nothing can stop — not the tick, not a release, not quit. The stop is checked as well as the record:
    // forgetting a record is a write, so a release in progress has already stopped this bot by the time a
    // record it is still deleting reads as present.
    const settled = await this.deps.store.bot(botId)
    if (
      this.stopped.has(botId) ||
      !settled ||
      settled.mode !== 'spectrum' ||
      settled.released ||
      settled.projectId !== record.projectId
    ) {
      await stopQuietly(app, this.log)
      return null
    }
    const raced = this.channels.get(botId)
    if (raced?.live) {
      await stopQuietly(app, this.log)
      return raced
    }
    // A raced channel whose stream already ended still owns an SDK client, and publishing over it would
    // leave that client unreachable: closed here, for the same reason the entry at the top is.
    raced?.stop()
    const channel = new PhotonSpectrumChannel({
      botId,
      projectId: record.projectId,
      app,
      // Spectrum numbers nothing, so the position is this computer's: after both the last one it
      // checkpointed and the highest its inbox already holds, because a restart that reused one would
      // give two entries the same position and replay them out of order.
      startSeq: Math.max(
        await this.deps.cursors.read(record.projectId).catch(() => 0),
        await this.deps.inbox.highestSeq(record.projectId).catch(() => 0)
      ),
      onMessage: async (message, seq) => {
        await this.deps.inbound.handle({ botId, projectId: record.projectId, seq, message })
      },
      log: this.log
    })
    channel.start()
    this.channels.set(botId, channel)
    return channel
  }

  stop(botId: string): void {
    // Recorded as well as acted on: a client that finishes opening after this point belongs to a channel
    // the caller will never hear from again, so `start` closes it rather than publishing it.
    this.stopped.add(botId)
    this.channels.get(botId)?.stop()
    this.channels.delete(botId)
  }

  /** Whether this run is reading this bot's project, which is what a status line shows. */
  running(botId: string): boolean {
    return this.channels.get(botId)?.live === true
  }

  /** Where a reply for this bot goes, or null when no channel is live — which the send path reports as a
   *  send that has not landed, keeping the answer queued rather than losing it. A channel whose stream
   *  ended holds a closed client, so handing it back would turn a queued answer into a failure. */
  transportFor(botId: string): PhotonSendTransport | null {
    const channel = this.channels.get(botId)
    if (!channel?.live) {
      return null
    }
    return { send: (conversationId, text) => channel.send(conversationId, text) }
  }

  /** Replaces a channel whose stream ended, and retries what its bot could not send. The same promise
   *  the stream tick makes for an account-provisioned bot: a live channel is left alone, a dead one is
   *  restarted rather than reported. Called by the one health tick, which the stream loop owns. */
  async tick(): Promise<void> {
    for (const record of await this.deps.store.bots()) {
      if (record.mode !== 'spectrum' || record.released) {
        continue
      }
      if (!this.channels.get(record.botId)?.live) {
        this.log('[photon] restarting a Spectrum stream that stopped', record.botId)
        this.stop(record.botId)
        await this.start(record.botId)
      }
      await this.deps.sendPath
        .retryPending(record.botId, null)
        .catch((error: unknown) =>
          this.log('[photon] could not retry a queued Spectrum answer', error)
        )
    }
  }
}
