// Photon's inbound stream: Socket.IO over HTTP, no webhook and no public endpoint, so it works behind
// NAT. The one thing that must be right is the reconnect: Socket.IO reconnects the socket on its own,
// but the server disables session recovery, so the application must subscribe again with its saved
// cursor. A reconnect that forgets to resubscribe hears nothing while looking healthy — which is why
// this reports `subscribed` separately from `connected` and arms a liveness deadline that says so.
import {
  PHOTON_STREAM_EVENTS,
  PHOTON_STREAM_PATH,
  PhotonStreamFrameSchema,
  PhotonSubscribeAckSchema,
  photonParse,
  type PhotonStreamFrame
} from './photon-contract'

/** The slice of a Socket.IO socket this needs, so a fake can model a drop and a silent reconnect. */
export type PhotonSocket = {
  on(event: string, handler: (...args: unknown[]) => void): void
  emit(event: string, payload: unknown): void
  disconnect(): void
}

export type PhotonIoFactory = (
  url: string,
  options: {
    path: string
    transports: string[]
    reconnection: boolean
    auth: { token: string }
  }
) => PhotonSocket

export type PhotonStreamState = 'idle' | 'connecting' | 'subscribed' | 'stalled' | 'stopped'

export type PhotonStreamStatus = {
  state: PhotonStreamState
  /** The socket is up. Not the same as hearing anything: see `subscribed`. */
  connected: boolean
  /** A subscribe was acknowledged, so frames may arrive. False after a reconnect until one is. */
  subscribed: boolean
  /** The cursor the last subscribe asked from. */
  startSeq: number
  /** How many times this stream has subscribed; a reconnect raises it again. */
  subscribes: number
  /** Why it stopped, when it did. */
  stoppedBy?: 'handler-failure' | 'closed' | 'contract'
}

export type PhotonStreamOptions = {
  io: PhotonIoFactory
  url: string
  projectId: string
  credential: string
  /** Read fresh on every subscribe, so a reconnect resumes after what Orca has already checkpointed. */
  readCursor: () => number
  /** Handles one frame. Throwing stops the stream, which is how a failed handler resumes from the
   *  last successful checkpoint instead of skipping the message it could not take. */
  onFrame: (frame: PhotonStreamFrame) => void | Promise<void>
  /** How long a connected socket may sit unsubscribed before the status reads `stalled`. */
  livenessTimeoutMs?: number
  log?: (message: string, ...rest: unknown[]) => void
  setTimer?: (callback: () => void, ms: number) => PhotonTimer
  clearTimer?: (timer: PhotonTimer) => void
}

/** A pending liveness deadline, in whatever shape the host's timers have. */
export type PhotonTimer = { cancel: () => void }

const DEFAULT_LIVENESS_MS = 15_000

export class PhotonStream {
  private socket: PhotonSocket | null = null
  private state: PhotonStreamState = 'idle'
  private connected = false
  private subscribed = false
  private startSeq = 0
  private subscribes = 0
  private stoppedBy: PhotonStreamStatus['stoppedBy']
  private liveness: PhotonTimer | null = null
  private readonly log: (message: string, ...rest: unknown[]) => void
  private readonly setTimer: (callback: () => void, ms: number) => PhotonTimer
  private readonly clearTimer: (timer: PhotonTimer) => void
  private readonly livenessMs: number

  constructor(private readonly options: PhotonStreamOptions) {
    this.log = options.log ?? ((message, ...rest) => console.warn(message, ...rest))
    this.setTimer =
      options.setTimer ??
      ((callback, ms) => {
        const handle = setTimeout(callback, ms)
        return { cancel: () => clearTimeout(handle) }
      })
    this.clearTimer = options.clearTimer ?? ((timer) => timer.cancel())
    this.livenessMs = options.livenessTimeoutMs ?? DEFAULT_LIVENESS_MS
  }

  start(): void {
    if (this.socket) {
      return
    }
    this.state = 'connecting'
    const socket = this.options.io(this.options.url, {
      path: PHOTON_STREAM_PATH,
      transports: ['websocket', 'polling'],
      // The socket reconnects itself; resubscribing is this class's job, and the server's session
      // recovery is off, so nothing else would.
      reconnection: true,
      auth: { token: this.options.credential }
    })
    this.socket = socket
    socket.on('connect', () => this.onConnect())
    socket.on('disconnect', () => this.onDisconnect())
    socket.on(PHOTON_STREAM_EVENTS.subscribed, (ack: unknown) => this.onSubscribed(ack))
    socket.on(PHOTON_STREAM_EVENTS.message, (frame: unknown) => void this.onMessage(frame))
    socket.on(PHOTON_STREAM_EVENTS.error, (error: unknown) =>
      this.log('[photon] stream error', error)
    )
  }

  stop(stoppedBy: PhotonStreamStatus['stoppedBy'] = 'closed'): void {
    this.disarmLiveness()
    this.socket?.disconnect()
    this.socket = null
    this.connected = false
    this.subscribed = false
    this.state = 'stopped'
    this.stoppedBy = stoppedBy
  }

  status(): PhotonStreamStatus {
    return {
      state: this.state,
      connected: this.connected,
      subscribed: this.subscribed,
      startSeq: this.startSeq,
      subscribes: this.subscribes,
      ...(this.stoppedBy ? { stoppedBy: this.stoppedBy } : {})
    }
  }

  /**
   * The liveness assertion. A stream that is connected but not subscribed is deaf, so it throws rather
   * than letting a silent stream look healthy; a `stalled` state throws for the same reason.
   */
  assertLive(): void {
    const status = this.status()
    if (status.state === 'stopped') {
      throw new Error(`The Photon stream is stopped (${status.stoppedBy ?? 'closed'}).`)
    }
    if (!status.connected) {
      throw new Error('The Photon stream is not connected.')
    }
    // A stalled stream is the more specific diagnosis, so it wins over the generic one: the socket is
    // up, the subscribe went out, and no acknowledgement came back.
    if (status.state === 'stalled') {
      throw new Error('The Photon stream did not acknowledge its subscribe in time.')
    }
    if (!status.subscribed) {
      throw new Error(
        'The Photon stream is connected but never resubscribed, so it would hear nothing; subscribe with the saved cursor.'
      )
    }
  }

  private onConnect(): void {
    this.connected = true
    this.subscribed = false
    this.state = 'connecting'
    this.subscribe()
  }

  private subscribe(): void {
    const socket = this.socket
    if (!socket) {
      return
    }
    // Read on every subscribe rather than once: a reconnect after a turn must resume from what Orca
    // checkpointed, not from where the stream started.
    this.startSeq = this.options.readCursor()
    socket.emit(PHOTON_STREAM_EVENTS.subscribe, {
      projectId: this.options.projectId,
      startSeq: this.startSeq
    })
    this.subscribes += 1
    this.armLiveness()
  }

  private onSubscribed(ack: unknown): void {
    try {
      const parsed = photonParse(PhotonSubscribeAckSchema, 'subscribe acknowledgement', ack)
      this.startSeq = parsed.startSeq
      this.subscribed = true
      this.state = 'subscribed'
      this.disarmLiveness()
    } catch (error) {
      this.log('[photon] refusing a subscribe acknowledgement', error)
      this.stop('contract')
    }
  }

  private onDisconnect(): void {
    this.connected = false
    this.subscribed = false
    this.disarmLiveness()
    if (this.state !== 'stopped') {
      this.state = 'connecting'
    }
  }

  private async onMessage(frame: unknown): Promise<void> {
    let parsed: PhotonStreamFrame
    try {
      parsed = photonParse(PhotonStreamFrameSchema, 'stream frame', frame)
    } catch (error) {
      // A frame Orca cannot read is a refused stream, not an ignored one: reading it as empty would
      // silently drop a message the cursor is about to move past.
      this.log('[photon] refusing a stream frame', error)
      this.stop('contract')
      return
    }
    try {
      await this.options.onFrame(parsed)
    } catch (error) {
      this.log(
        '[photon] a frame handler failed; stopping so the stream resumes from the checkpoint',
        error
      )
      this.stop('handler-failure')
    }
  }

  private armLiveness(): void {
    this.disarmLiveness()
    this.liveness = this.setTimer(() => {
      this.liveness = null
      if (!this.subscribed && this.state !== 'stopped') {
        this.state = 'stalled'
        this.log(
          '[photon] the stream is connected but has not acknowledged a subscribe; it is deaf until it does'
        )
      }
    }, this.livenessMs)
  }
  private disarmLiveness(): void {
    if (this.liveness !== null) {
      this.clearTimer(this.liveness)
      this.liveness = null
    }
  }
}
