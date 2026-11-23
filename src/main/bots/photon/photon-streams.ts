// One stream per bot, and the tick that keeps them honest. Split from the service because it owns the
// only long-lived state in the channel: a stream that stopped itself is replaced rather than returned
// dead, a stream that is connected but never subscribed is restarted rather than merely called deaf, and
// a send that failed is retried instead of sitting in the outbox until the process dies.
import type { PhotonCursorStore } from './photon-cursor'
import type { PhotonInbound } from './photon-inbound'
import type { PhotonSendPath } from './photon-send'
import { PhotonStream, type PhotonIoFactory, type PhotonStreamStatus } from './photon-stream'
import type { PhotonStore } from './photon-store'
import { PHOTON_STREAM_URL } from './photon-contract'

export type PhotonTimer = { cancel: () => void }

export type PhotonStreamsDeps = {
  store: PhotonStore
  cursors: PhotonCursorStore
  inbound: PhotonInbound
  sendPath: PhotonSendPath
  io: PhotonIoFactory
  streamUrl?: string
  log?: (message: string, ...rest: unknown[]) => void
  /** How often the health tick runs. Absent means no tick, which is what a test wants. */
  healthIntervalMs?: number
  setTimer?: (callback: () => void, ms: number) => PhotonTimer
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
  startAll(): void {
    for (const record of this.deps.store.bots()) {
      if (!record.released) {
        this.start(record.botId)
      }
    }
    this.startHealth()
  }

  start(botId: string): PhotonStreamStatus | null {
    const running = this.streams.get(botId)
    if (running && running.status().state !== 'stopped') {
      return running.status()
    }
    // A stream that stopped itself (a handler failure or a refused frame) is replaced rather than
    // reused: returning the dead one early is what left a bot deaf until restart.
    this.streams.delete(botId)
    const record = this.deps.store.bot(botId)
    const credential = this.deps.store.projectCredential(botId)
    if (!record || record.released || !credential) {
      return null
    }
    const stream = new PhotonStream({
      io: this.deps.io,
      url: this.deps.streamUrl ?? PHOTON_STREAM_URL,
      projectId: record.projectId,
      credential: credential.key,
      // Read fresh on every subscribe, so a reconnect resumes after what Orca checkpointed.
      readCursor: () => this.deps.cursors.read(record.projectId),
      onFrame: (frame) =>
        this.deps.inbound
          .handle({ botId, projectId: record.projectId, seq: frame.seq, message: frame.message })
          .then(() => undefined),
      log: this.deps.log
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
   * The tick that makes two promises true rather than aspirational: a stream that is connected but never
   * subscribed (`deaf`) is restarted instead of merely reported, and a send that failed is retried
   * instead of sitting in the outbox until the process dies.
   */
  tick(): void {
    // Snapshot: a restart replaces the entry, and iterating a Map while adding to it would visit the
    // replacement and restart it forever.
    for (const [botId, stream] of Array.from(this.streams)) {
      const status = stream.status()
      if (status.state === 'stopped' && status.stoppedBy !== 'closed') {
        this.log('[photon] restarting a stream that stopped itself', botId, status.stoppedBy)
        this.streams.delete(botId)
        this.start(botId)
        continue
      }
      // The liveness assertion, with a caller that acts on it: reporting `deaf` in a status nobody polls
      // was not a mechanism. A stop-then-start is what clears it.
      try {
        stream.assertLive()
      } catch (error) {
        this.log('[photon] restarting a stream that is not live', botId, messageOf(error))
        this.stop(botId)
        this.start(botId)
      }
    }
    for (const record of this.deps.store.bots()) {
      const credential = this.deps.store.projectCredential(record.botId)
      if (record.released || !credential) {
        continue
      }
      void this.deps.sendPath
        .retryPending(record.botId, credential)
        .catch((error: unknown) => this.log('[photon] could not retry queued sends', error))
    }
  }

  private startHealth(): void {
    if (this.health || this.deps.setTimer === undefined) {
      return
    }
    const schedule = (): void => {
      this.health =
        this.deps.setTimer?.(() => {
          try {
            this.tick()
          } catch (error) {
            this.log('[photon] the health tick failed', error)
          }
          schedule()
        }, this.deps.healthIntervalMs ?? DEFAULT_HEALTH_MS) ?? null
    }
    schedule()
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
