// A scripted gateway, in memory: it records every frame the client sends and lets a test drive the
// frames Discord would send back. The client is exercised through real payloads rather than by
// reaching into its internals, and every knob here exists because a test needs that step to happen.
import { DISCORD_OP } from './discord-contract'
import type { DiscordGatewayEvents, DiscordGatewaySocket } from './discord-gateway'

export type FakeSentFrame = { op: number; d?: unknown; s?: number | null; t?: string | null }

export type FakeReadyOptions = { sessionId?: string; resumeUrl?: string; seq?: number }

/** One connection as the client saw it: what it sent, and how it was closed. */
export class FakeDiscordGatewaySocket implements DiscordGatewaySocket {
  readonly url: string
  /** When the socket was opened, from the same clock the gateway under test reads. */
  readonly openedAt: number
  readonly sent: FakeSentFrame[] = []
  readonly closeCodes: (number | undefined)[] = []
  private readonly handlers = new Map<string, ((payload?: unknown) => void)[]>()

  constructor(url: string, openedAt: number) {
    this.url = url
    this.openedAt = openedAt
  }

  on<Event extends keyof DiscordGatewayEvents>(
    event: Event,
    handler: DiscordGatewayEvents[Event]
  ): void {
    const list = this.handlers.get(event) ?? []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every handler is called with its own event payload
    list.push(handler as (payload?: unknown) => void)
    this.handlers.set(event, list)
  }

  send(data: string): void {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the gateway only ever sends its own frames
    this.sent.push(JSON.parse(data) as FakeSentFrame)
  }

  close(code?: number): void {
    this.closeCodes.push(code)
  }

  /** Frames the client sent with this opcode, in order. */
  sentWith(op: number): FakeSentFrame[] {
    return this.sent.filter((frame) => frame.op === op)
  }

  get lastSent(): FakeSentFrame | undefined {
    return this.sent.at(-1)
  }

  // --- the driver: frames Discord would send ---

  fireOpen(): void {
    this.fire('open')
  }

  /** op 10, the first frame on every connection, docs: gateway-events (hello). */
  hello(heartbeatInterval = 45_000): void {
    this.fire(
      'message',
      JSON.stringify({ op: DISCORD_OP.HELLO, d: { heartbeat_interval: heartbeatInterval } })
    )
  }

  /** op 0 READY: the session id and the URL a resume must use, docs: gateway-events (ready). */
  ready(options: FakeReadyOptions = {}): void {
    const { sessionId = 'sess_1', resumeUrl = 'wss://resume.discord.gg', seq = 1 } = options
    this.dispatch('READY', { session_id: sessionId, resume_gateway_url: resumeUrl }, seq)
  }

  /** op 0 RESUMED: the resume was accepted and the missed events follow, docs: gateway-events (resumed). */
  resumed(seq = 2): void {
    this.dispatch('RESUMED', {}, seq)
  }

  dispatch(t: string, d: unknown, s: number): void {
    this.fire('message', JSON.stringify({ op: DISCORD_OP.DISPATCH, t, d, s }))
  }

  /** op 7: reconnect and resume, docs: gateway-events (reconnect). */
  reconnect(): void {
    this.fire('message', JSON.stringify({ op: DISCORD_OP.RECONNECT, d: null }))
  }

  /** op 9: `d` says whether the session is still resumable, docs: gateway-events (invalid session). */
  invalidSession(resumable: boolean): void {
    this.fire('message', JSON.stringify({ op: DISCORD_OP.INVALID_SESSION, d: resumable }))
  }

  heartbeatAck(): void {
    this.fire('message', JSON.stringify({ op: DISCORD_OP.HEARTBEAT_ACK, d: null }))
  }

  /** op 1 from the server: the client must answer immediately, docs: gateway (heartbeat requests). */
  requestHeartbeat(): void {
    this.fire('message', JSON.stringify({ op: DISCORD_OP.HEARTBEAT, d: null }))
  }

  /** A close event; no code models the disconnect that arrives without one. */
  drop(code?: number): void {
    this.fire('close', code)
  }

  fireError(error: unknown = new Error('socket failed')): void {
    this.fire('error', error)
  }

  private fire(event: string, payload?: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(payload)
    }
  }
}

export type FakeDiscordGatewayOptions = {
  /** Session starts left in the allowance; `undefined` omits the object entirely. */
  remaining?: number
  /** The URL Get Gateway Bot returns; a resume must instead use READY's `resume_gateway_url`. */
  url?: string
  /** The clock the gateway under test reads, so `openedAt` lines up with its timers. */
  now?: () => number
}

export type FakeDiscordGateway = {
  openSocket: (url: string) => DiscordGatewaySocket
  getGatewayUrl: () => Promise<{ url: string; sessionStartLimit?: { remaining: number } }>
  sockets: FakeDiscordGatewaySocket[]
  /** The connection the client is on now; every test opens one before driving frames. */
  current: () => FakeDiscordGatewaySocket
  urls: () => string[]
  /** Change the remaining session starts mid-test. */
  setRemaining: (remaining: number | undefined) => void
  /** How many times the URL was fetched, so a test can tell a cached URL from a fresh one. */
  gatewayFetches: () => number
}

export function createFakeDiscordGateway(
  options: FakeDiscordGatewayOptions = {}
): FakeDiscordGateway {
  const url = options.url ?? 'wss://gateway.discord.gg'
  const now = options.now ?? ((): number => 0)
  const sockets: FakeDiscordGatewaySocket[] = []
  let remaining: number | undefined = options.remaining ?? 1_000
  let fetches = 0
  return {
    openSocket: (target) => {
      const socket = new FakeDiscordGatewaySocket(target, now())
      sockets.push(socket)
      return socket
    },
    getGatewayUrl: () => {
      fetches += 1
      const left = remaining
      return Promise.resolve({
        url,
        ...(left === undefined ? {} : { sessionStartLimit: { remaining: left } })
      })
    },
    sockets,
    current: () => {
      const socket = sockets.at(-1)
      if (!socket) {
        throw new Error('the gateway opened no socket')
      }
      return socket
    },
    urls: () => sockets.map((socket) => socket.url),
    setRemaining: (next) => {
      remaining = next
    },
    gatewayFetches: () => fetches
  }
}
