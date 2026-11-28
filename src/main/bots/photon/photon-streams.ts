// One stream per bot, and the tick that keeps them honest. Split from the service because it owns the
// only long-lived state in the channel: a stream that stopped itself is replaced rather than returned
// dead, a stream that is connected but never subscribed is restarted rather than merely called deaf, and
// a send that failed is retried instead of sitting in the outbox until the process dies.
import type { PhotonCredential } from './photon-api'
import type { PhotonCursorStore } from './photon-cursor'
import type { PhotonInbound } from './photon-inbound'
import { PhotonStream, type PhotonIoFactory, type PhotonStreamStatus } from './photon-stream'
import type { PhotonStore } from './photon-store'
import { PHOTON_STREAM_URL } from './photon-contract'

export type PhotonTimer = { cancel: () => void }

/** The one thing a stream asks of the inbound adapter: take a frame, and say how it went. A test gives
 *  it only that, which is what a handler that always fails is. */
export type PhotonFrameHandler = {
  handle(input: Parameters<PhotonInbound['handle']>[0]): Promise<unknown>
}

/** The one thing the tick asks of the send path: retry what is waiting. The outcome is the send path's
 *  own report and the tick does not read it, so it is not named here. */
export type PhotonSendRetry = {
  retryPending(botId: string, credential: PhotonCredential): Promise<unknown>
}

export type PhotonStreamsDeps = {
  store: PhotonStore
  cursors: PhotonCursorStore
  inbound: PhotonFrameHandler
  sendPath: PhotonSendRetry
  io: PhotonIoFactory
  streamUrl?: string
  log?: (message: string, ...rest: unknown[]) => void
  /**
   * The other credential mode's channels, ticked by the clock below. One owner for restart and retry: a
   * bot on an owner's own Spectrum project has no project key, so this loop used to skip it entirely and
   * its channel was left to a `healthTick()` nothing in production called.
   */
  peerChannels?: { tick(): Promise<void> }
  /** How often the health tick runs. Absent means no tick, which is what a test wants. */
  healthIntervalMs?: number
  /** Handed to every stream as well as used by the tick, so one clock drives the whole channel. */
  setTimer?: (callback: () => void, ms: number) => PhotonTimer
  clearTimer?: (timer: PhotonTimer) => void
}

const DEFAULT_HEALTH_MS = 60_000

export class PhotonStreams {
  private readonly streams = new Map<string, PhotonStream>()
  private health: PhotonTimer | null = null

  private readonly log: (message: string, ...rest: unknown[]) => void

  constructor(private readonly deps: PhotonStreamsDeps) {
    this.log = deps.log ?? ((message, ...rest) => console.warn(message, ...rest))
  }

  /** Follows every bot that has a key and has not been released. A bot with no project is skipped
   *  rather than failing loudly. */
  async startAll(): Promise<void> {
    for (const record of await this.deps.store.bots()) {
      if (!record.released) {
        await this.start(record.botId)
      }
    }
    this.startHealth()
  }

  async start(botId: string): Promise<PhotonStreamStatus | null> {
    const running = this.streams.get(botId)
    if (running && running.status().state !== 'stopped') {
      return running.status()
    }
    // A stream that stopped itself (a handler failure or a refused frame) is replaced rather than
    // reused: returning the dead one early is what left a bot deaf until restart. Its resume count
    // comes along, so a repeatable failure keeps backing off instead of restarting at 1 s.
    const spentResumes = running?.status().resumes ?? 0
    this.streams.delete(botId)
    const record = await this.deps.store.bot(botId)
    const credential = await this.deps.store.projectCredential(botId)
    // The mode is read rather than inferred from the missing key: a bot on an owner's own Spectrum project
    // has no project key by design, and that is a channel this loop does not own.
    if (!record || record.mode !== 'account' || record.released || !credential) {
      return null
    }
    const stream = new PhotonStream({
      io: this.deps.io,
      url: this.deps.streamUrl ?? PHOTON_STREAM_URL,
      projectId: record.projectId,
      credential: credential.key,
      // Read fresh on every subscribe, so a reconnect resumes after what Orca checkpointed.
      readCursor: () => this.deps.cursors.read(record.projectId),
      resumes: spentResumes,
      onFrame: (frame) =>
        this.deps.inbound
          .handle({ botId, projectId: record.projectId, seq: frame.seq, message: frame.message })
          .then(() => undefined),
      // The same clock the tick uses. A stream's own liveness and resume deadlines are what a test has
      // to reach to prove that a stopped stream's resume was cancelled and not merely forgotten.
      ...(this.deps.setTimer ? { setTimer: this.deps.setTimer } : {}),
      ...(this.deps.clearTimer ? { clearTimer: this.deps.clearTimer } : {}),
      log: this.log
    })
    try {
      stream.start()
    } catch (error) {
      // A stream that will not open is not a provisioning failure: the project, its key and its number
      // are already real, and reporting the bot as created is the truthful answer.
      this.log('[photon] could not open a stream for a bot', error)
      return null
    }
    this.streams.set(botId, stream)
    this.startHealth()
    return stream.status()
  }

  stop(botId: string): void {
    this.streams.get(botId)?.stop()
    this.streams.delete(botId)
  }

  stopAll(): void {
    for (const botId of Array.from(this.streams.keys())) {
      this.stop(botId)
    }
    this.health?.cancel()
    this.health = null
  }

  status(botId: string): PhotonStreamStatus | null {
    return this.streams.get(botId)?.status() ?? null
  }

  /**
   * The tick that makes two promises true rather than aspirational — for both credential modes: a stream
   * that is connected but never subscribed (`deaf`) is restarted instead of merely reported, a send that
   * failed is retried instead of sitting in the outbox until the process dies, and a Spectrum channel that
   * ended is replaced by the registry this one ticks.
   */
  async tick(): Promise<void> {
    // Snapshot: a restart replaces the entry, and iterating a Map while adding to it would visit the
    // replacement and restart it forever.
    for (const [botId, stream] of Array.from(this.streams)) {
      const status = stream.status()
      if (status.state === 'stopped' && status.stoppedBy !== 'closed') {
        // Why not for a refused frame: the replay hands back the same bytes, so a reconnect cannot
        // cure it — it only re-reads the poison every interval and logs a restart each time. The
        // stream stays down and `assertLive` names why.
        if (status.stoppedBy === 'contract') {
          this.log(
            '[photon] a stream is down on a frame Orca cannot parse; reconnecting would re-read it',
            botId
          )
          continue
        }
        // Why not while a resume is armed: the stream's own timer is what grows the backoff, and a
        // replacement here cancels it and reconnects on the tick instead — one socket a minute, for
        // ever, against a provider that counts them.
        if (status.resumeInMs !== undefined) {
          continue
        }
        // `stop()` rather than dropping the map entry: a stopped stream may still hold a resume timer,
        // and deleting it from the map alone lets that timer reconnect a socket nothing references any
        // more — unreachable by stop(), by stopAll() and by a release.
        this.log('[photon] restarting a stream that stopped itself', botId, status.stoppedBy)
        this.stop(botId)
        await this.start(botId)
        continue
      }
      // The liveness assertion, with a caller that acts on it: reporting `deaf` in a status nobody polls
      // was not a mechanism. A stop-then-start is what clears it.
      try {
        stream.assertLive()
      } catch (error) {
        this.log('[photon] restarting a stream that is not live', botId, messageOf(error))
        this.stop(botId)
        await this.start(botId)
      }
    }
    for (const record of await this.deps.store.bots()) {
      if (record.mode !== 'account' || record.released) {
        continue
      }
      const credential = await this.deps.store.projectCredential(record.botId)
      if (!credential) {
        continue
      }
      void this.deps.sendPath
        .retryPending(record.botId, credential)
        .catch((error: unknown) => this.log('[photon] could not retry queued sends', error))
    }
    // The other credential mode, on the same clock: a Spectrum channel that stopped is restarted and its
    // queued answers retried, which is the promise this tick makes for this mode too.
    if (this.deps.peerChannels) {
      try {
        await this.deps.peerChannels.tick()
      } catch (error) {
        this.log('[photon] the Spectrum tick failed', error)
      }
    }
  }

  private startHealth(): void {
    if (this.health || this.deps.setTimer === undefined) {
      return
    }
    const schedule = (): void => {
      this.health =
        this.deps.setTimer?.(() => {
          // Awaiting inside the callback is what gives the catch a rejection to see: `tick` is async, so
          // a `try` around the call itself caught nothing and every failure went unhandled.
          void this.tick()
            .catch((error: unknown) => this.log('[photon] the health tick failed', error))
            .finally(schedule)
        }, this.deps.healthIntervalMs ?? DEFAULT_HEALTH_MS) ?? null
    }
    schedule()
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
