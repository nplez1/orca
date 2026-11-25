// The Discord gateway connection: Hello, heartbeats, identify-or-resume, and the close-code table that
// decides which of the two a disconnect deserves. Session state is memory-only; nothing persists.
import {
  DISCORD_DEFAULT_INTENTS,
  DISCORD_GATEWAY_VERSION,
  DISCORD_OP,
  DiscordGatewayPayloadSchema,
  discordCloseDecision,
  type DiscordGatewayPayload
} from './discord-contract'
import { readField, readString } from './discord-frame-read'

/** The doc's Connecting/Heartbeating/Identifying/Resuming, plus the two states the caller acts on. */
type LiveState = 'connecting' | 'identifying' | 'resuming' | 'ready' | 'deaf' | 'backoff'
export type DiscordGatewayState = 'idle' | 'stopped' | LiveState

export type DiscordGatewayEvents = {
  open: () => void
  message: (data: string) => void
  close: (code?: number) => void
  error: (error: unknown) => void
}

/** The minimum of a WebSocket this module needs, so production can pass `ws` and a test a fake. */
export type DiscordGatewaySocket = {
  send: (data: string) => void
  close: (code?: number) => void
  on: <E extends keyof DiscordGatewayEvents>(event: E, handler: DiscordGatewayEvents[E]) => void
}

export type DiscordGatewayFatalReason =
  | 'token_invalid'
  | 'intent_rejected'
  | 'sharding_unsupported'
  | 'budget_exhausted'

export type DiscordGatewayDeps = {
  token: string
  /** Injected socket factory; production passes one built on `ws`. */
  openSocket: (url: string) => DiscordGatewaySocket
  /** Get Gateway Bot: the WSS URL plus the session-start allowance, docs: gateway (get gateway bot). */
  getGatewayUrl: () => Promise<{ url: string; sessionStartLimit?: { remaining: number } }>
  now?: () => number
  random?: () => number
  onDispatch?: (event: { t: string; d: unknown; s: number }) => void
  onState?: (state: DiscordGatewayState) => void
  onFatal?: (reason: DiscordGatewayFatalReason, detail: string) => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** An identify costs one of the 1000 a day and the limit is global, so a reconnect loop must stop
 *  while some is left rather than burn the allowance to zero, docs: gateway (identifying). */
export const DISCORD_IDENTIFY_BUDGET_FLOOR = 10

/** Any code but 1000/1001 leaves the session resumable, so a zombie is closed with 4000,
 *  docs: gateway (sending heartbeats, initiating a disconnect). */
export const DISCORD_ZOMBIE_CLOSE_CODE = 4000

/** A connect that never produces READY or RESUMED is a socket the caller should restart. */
export const DISCORD_READY_TIMEOUT_MS = 15_000
export const DISCORD_RECONNECT_BASE_MS = 1_000
export const DISCORD_RECONNECT_MAX_MS = 300_000
/** How long to wait before answering an Invalid Session; the docs only say to retry, not how soon. */
export const DISCORD_INVALID_SESSION_MIN_MS = 1_000
export const DISCORD_INVALID_SESSION_MAX_MS = 5_000

/** Close codes the docs mark `reconnect: false` that also name a reason this module can report. */
const TERMINAL_REASONS: Readonly<Record<number, DiscordGatewayFatalReason>> = {
  4004: 'token_invalid',
  4011: 'sharding_unsupported',
  4013: 'intent_rejected',
  4014: 'intent_rejected'
}

type Mode = 'identify' | 'resume'
type Session = { id: string; resumeUrl: string | undefined }

export function createDiscordGateway(deps: DiscordGatewayDeps) {
  const now = deps.now ?? Date.now
  const random = deps.random ?? Math.random
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms))
  const clearTimer =
    deps.clearTimer ??
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handle came from the default setTimeout above
    ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>))

  let state: DiscordGatewayState = 'idle'
  /** The live connection; a frame from any other socket is stale and ignored. */
  let socket: DiscordGatewaySocket | undefined
  let stopped = false
  let dispatchCount = 0
  let reconnectAttempt = 0
  let seq: number | null = null
  let session: Session | undefined
  let cachedUrl: string | undefined
  let heartbeatIntervalMs = 0
  /** True while a heartbeat is outstanding: an unacked one means the connection is zombied. */
  let awaitingAck = false
  const timers: { heartbeat?: unknown; ready?: unknown; reconnect?: unknown } = {}

  function stopTimer(key: keyof typeof timers): void {
    if (timers[key] !== undefined) {
      clearTimer(timers[key])
    }
    timers[key] = undefined
  }

  function detach(): void {
    socket = undefined
    stopTimer('heartbeat')
    stopTimer('ready')
    stopTimer('reconnect')
  }

  function setState(next: DiscordGatewayState): void {
    if (state === next) {
      return
    }
    state = next
    deps.onState?.(next)
  }

  /** Drops the current socket before closing it: the close event that follows is then stale. */
  function dropSocket(code: number): void {
    const current = socket
    detach()
    current?.close(code)
  }

  function send(op: number, d: unknown): void {
    socket?.send(JSON.stringify({ op, d }))
  }

  function clearSession(): void {
    session = undefined
    seq = null
  }

  function sendIdentify(): void {
    setState('identifying')
    send(DISCORD_OP.IDENTIFY, {
      token: deps.token,
      intents: DISCORD_DEFAULT_INTENTS,
      properties: { os: process.platform, browser: 'orca', device: 'orca' }
    })
  }

  /** Runs on its own timer, never behind a dispatch handler, docs: gateway (sending heartbeats). */
  function beat(): void {
    if (awaitingAck) {
      dropSocket(DISCORD_ZOMBIE_CLOSE_CODE)
      scheduleReconnect(session ? 'resume' : 'identify', 0)
      return
    }
    awaitingAck = true
    send(DISCORD_OP.HEARTBEAT, seq)
    timers.heartbeat = setTimer(beat, heartbeatIntervalMs)
  }

  function scheduleReconnect(mode: Mode, delayMs?: number): void {
    if (stopped) {
      return
    }
    setState('backoff')
    reconnectAttempt += 1
    const base = DISCORD_RECONNECT_BASE_MS * 2 ** (reconnectAttempt - 1)
    // Equal jitter: half of every window is fixed, and the cap stays a real ceiling.
    const delay = delayMs ?? Math.round(Math.min(base * (0.5 + random()), DISCORD_RECONNECT_MAX_MS))
    timers.reconnect = setTimer(() => {
      timers.reconnect = undefined
      void connect(mode)
    }, delay)
  }

  /** A starved timer can fire early, so the deadline is measured rather than assumed. */
  function armReadyWatchdog(openedAt: number): void {
    const remaining = DISCORD_READY_TIMEOUT_MS - (now() - openedAt)
    if (remaining <= 0) {
      setState('deaf')
      return
    }
    timers.ready = setTimer(() => armReadyWatchdog(openedAt), remaining)
  }

  async function connect(mode: Mode): Promise<void> {
    if (stopped) {
      return
    }
    setState('connecting')
    let url = mode === 'resume' ? (session?.resumeUrl ?? cachedUrl) : undefined
    try {
      if (url === undefined) {
        const info = await deps.getGatewayUrl()
        const remaining = info.sessionStartLimit?.remaining
        // Only an identify spends the allowance; a resume does not count against it.
        const nearLimit = remaining !== undefined && remaining < DISCORD_IDENTIFY_BUDGET_FLOOR
        if (mode === 'identify' && nearLimit) {
          stopped = true
          detach()
          setState('stopped')
          deps.onFatal?.('budget_exhausted', `${remaining} session starts left, below the reserve`)
          return
        }
        url = cachedUrl = info.url
      }
      if (stopped) {
        return
      }
      const next = deps.openSocket(
        `${url.replace(/\/+$/, '')}/?v=${DISCORD_GATEWAY_VERSION}&encoding=json`
      )
      socket = next
      armReadyWatchdog(now())
      next.on('message', (data) => onFrame(next, data))
      next.on('close', (code) => onClose(next, code))
      // `ws` emits close after error, so an error only matters while this socket is the live one.
      next.on('error', () => onClose(next, undefined))
    } catch {
      // A failed Get Gateway Bot is a network failure like any other, so it backs off.
      scheduleReconnect(mode)
    }
  }

  function onHello(d: unknown): void {
    const interval = readField(d, 'heartbeat_interval')
    if (typeof interval !== 'number' || interval <= 0) {
      return
    }
    heartbeatIntervalMs = interval
    awaitingAck = false
    // The first beat is offset by a random fraction of the interval, docs: gateway (heartbeat interval).
    timers.heartbeat = setTimer(beat, Math.round(interval * random()))
    if (!session) {
      sendIdentify()
      return
    }
    setState('resuming')
    // `seq` is an integer in the resume structure, so a session that dispatched nothing starts at 0.
    send(DISCORD_OP.RESUME, { token: deps.token, session_id: session.id, seq: seq ?? 0 })
  }

  function onDispatchFrame(payload: DiscordGatewayPayload): void {
    seq = typeof payload.s === 'number' ? payload.s : seq
    dispatchCount += 1
    const t = payload.t ?? ''
    if (t === 'READY' || t === 'RESUMED') {
      if (t === 'READY') {
        const id = readString(payload.d, 'session_id') ?? ''
        session = { id, resumeUrl: readString(payload.d, 'resume_gateway_url') }
      }
      reconnectAttempt = 0
      stopTimer('ready')
      setState('ready')
    }
    // Dispatch frames always carry `s`; one that does not reports the last sequence seen.
    deps.onDispatch?.({ t, d: payload.d, s: seq ?? 0 })
  }

  function onFrame(from: DiscordGatewaySocket, data: string): void {
    const payload = from === socket ? parseFrame(data) : undefined
    if (!payload) {
      return
    }
    if (payload.op === DISCORD_OP.HELLO) {
      onHello(payload.d)
    } else if (payload.op === DISCORD_OP.HEARTBEAT) {
      // A server heartbeat request is answered now, docs: gateway (heartbeat requests).
      awaitingAck = true
      send(DISCORD_OP.HEARTBEAT, seq)
    } else if (payload.op === DISCORD_OP.HEARTBEAT_ACK) {
      awaitingAck = false
    } else if (payload.op === DISCORD_OP.RECONNECT) {
      dropSocket(DISCORD_ZOMBIE_CLOSE_CODE)
      scheduleReconnect(session ? 'resume' : 'identify', 0)
    } else if (payload.op === DISCORD_OP.INVALID_SESSION) {
      const resumable = payload.d === true
      dropSocket(DISCORD_ZOMBIE_CLOSE_CODE)
      if (!resumable) {
        // The session cannot be resumed, so the next connection has to identify, docs: gateway-events.
        clearSession()
      }
      const spread = DISCORD_INVALID_SESSION_MAX_MS - DISCORD_INVALID_SESSION_MIN_MS
      scheduleReconnect(
        resumable && session ? 'resume' : 'identify',
        DISCORD_INVALID_SESSION_MIN_MS + Math.round(random() * spread)
      )
    } else if (payload.op === DISCORD_OP.DISPATCH) {
      onDispatchFrame(payload)
    }
  }

  function onClose(from: DiscordGatewaySocket, code?: number): void {
    const live = from === socket
    detach()
    if (!live || stopped) {
      return
    }
    const decision = code === undefined ? 'resume' : discordCloseDecision(code)
    if (decision === 'stop') {
      const reason = code === undefined ? undefined : TERMINAL_REASONS[code]
      stopped = true
      clearSession()
      setState('stopped')
      // 4010 and 4012 are terminal too, but name no reason this module reports; nothing reconnects.
      if (reason !== undefined) {
        deps.onFatal?.(reason, `gateway closed with ${code}`)
      }
      return
    }
    if (decision === 'identify') {
      clearSession()
    }
    scheduleReconnect(decision === 'resume' && session ? 'resume' : 'identify')
  }

  return {
    start(): void {
      if (state === 'idle' || state === 'deaf') {
        stopped = false
        void connect(session ? 'resume' : 'identify')
      }
    },
    stop(): void {
      stopped = true
      clearSession()
      // 1000 invalidates the session and takes the bot offline, docs: gateway (initiating a disconnect).
      dropSocket(1000)
      setState('stopped')
    },
    /** Sleep starves the timers, so a wake forces a resume rather than trusting them. */
    handleSleepResume(): void {
      if (!stopped && state !== 'idle') {
        dropSocket(DISCORD_ZOMBIE_CLOSE_CODE)
        scheduleReconnect(session ? 'resume' : 'identify', 0)
      }
    },
    getState: (): DiscordGatewayState => state,
    getDispatchCount: (): number => dispatchCount,
    isDeaf: (): boolean => state === 'deaf'
  }
}

function parseFrame(data: string): DiscordGatewayPayload | undefined {
  try {
    const parsed = DiscordGatewayPayloadSchema.safeParse(JSON.parse(data))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}
