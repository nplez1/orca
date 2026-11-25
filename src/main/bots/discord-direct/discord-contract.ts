// Discord's protocol facts, in one place: the REST root, the gateway opcodes and intents a direct
// bot uses, the close-code table that decides whether a disconnect resumes or stops, and the message
// limits the chunker enforces. A wrong value here is one edit, not a hunt through a connector.
import { z } from 'zod'

/** REST root; the version lives in the path, so a bump is one constant, docs: reference (API versioning). */
export const DISCORD_API_BASE = 'https://discord.com/api/v10'

/** Gateway API version, sent as `?v=10` on every socket URL, docs: gateway (gateway url query string params). */
export const DISCORD_GATEWAY_VERSION = 10

/** Sent on every REST call; Discord only documents that a proper one avoids a Cloudflare 40333,
 *  docs: opcodes-and-status-codes (HTTP status codes). */
export const DISCORD_USER_AGENT = 'DiscordBot (https://github.com/nplez1/orca, 1.0)'

/** Gateway opcodes Orca uses, docs: opcodes-and-status-codes (gateway opcodes). */
export const DISCORD_OP = {
  /** An event was dispatched. */
  DISPATCH: 0,
  /** Sent periodically to keep the connection alive. */
  HEARTBEAT: 1,
  /** Starts a new session during the initial handshake. */
  IDENTIFY: 2,
  /** Resumes a session that was disconnected. */
  RESUME: 6,
  /** Discord's instruction to reconnect and resume immediately. */
  RECONNECT: 7,
  /** The session was invalidated; `d` says whether it is still resumable. */
  INVALID_SESSION: 9,
  /** Sent first on connect, carrying `heartbeat_interval`. */
  HELLO: 10,
  /** Acknowledges a heartbeat we sent. */
  HEARTBEAT_ACK: 11
} as const
export type DiscordOp = (typeof DISCORD_OP)[keyof typeof DISCORD_OP]

/** Intents as bit shifts read off the intents table, docs: gateway (list of intents). */
export const DISCORD_INTENTS = {
  /** Guild, channel and thread lifecycle events, `1 << 0`. */
  GUILDS: 1 << 0,
  /** Guild message create/update/delete, `1 << 9`. */
  GUILD_MESSAGES: 1 << 9,
  /** Direct message create/update/delete, `1 << 12`. */
  DIRECT_MESSAGES: 1 << 12
} as const

/** The three intents above ORed: the least a bot needs to see and answer a message anywhere. */
export const DISCORD_DEFAULT_INTENTS =
  DISCORD_INTENTS.GUILDS | DISCORD_INTENTS.GUILD_MESSAGES | DISCORD_INTENTS.DIRECT_MESSAGES

/** Gateway close codes with the table's `reconnect` column, docs: opcodes-and-status-codes
 *  (gateway close event codes). */
export const DISCORD_CLOSE_CODES = {
  4000: { name: 'Unknown error', reconnect: true },
  4001: { name: 'Unknown opcode', reconnect: true },
  4002: { name: 'Decode error', reconnect: true },
  4003: { name: 'Not authenticated', reconnect: true },
  4004: { name: 'Authentication failed', reconnect: false },
  4005: { name: 'Already authenticated', reconnect: true },
  4007: { name: 'Invalid seq', reconnect: true },
  4008: { name: 'Rate limited', reconnect: true },
  4009: { name: 'Session timed out', reconnect: true },
  4010: { name: 'Invalid shard', reconnect: false },
  4011: { name: 'Sharding required', reconnect: false },
  4012: { name: 'Invalid API version', reconnect: false },
  4013: { name: 'Invalid intent(s)', reconnect: false },
  4014: { name: 'Disallowed intent(s)', reconnect: false }
} as const
export type DiscordCloseCode = keyof typeof DISCORD_CLOSE_CODES

/** What a closed socket should do next: keep the session, start a fresh one, or give up. */
export type DiscordCloseDecision = 'resume' | 'identify' | 'stop'

/** `4007`/`4009` are the codes the docs tell you to reconnect *and start a new session*; every other
 *  reconnectable code — and any code the table does not list — resumes, docs: gateway (resuming). */
export function discordCloseDecision(code: number): DiscordCloseDecision {
  const known: { reconnect: boolean } | undefined = Object.entries(DISCORD_CLOSE_CODES).find(
    ([entryCode]) => entryCode === String(code)
  )?.[1]
  if (known && !known.reconnect) {
    return 'stop'
  }
  if (code === 4007 || code === 4009) {
    return 'identify'
  }
  return 'resume'
}

/** Message content limit, counted in UTF-16 code units; docs: message (create message), "up to 2000
 *  characters". Code units are the conservative reading: they never exceed a code-point limit. */
export const DISCORD_MESSAGE_CONTENT_LIMIT = 2000

/** Replies beyond this many chunks are too long to send as messages at all, so callers can say so. */
export const DISCORD_MAX_CHUNKS = 3

/** Typing indicators expire after 10 s, so refresh a little under it, docs: channel (trigger typing indicator). */
export const DISCORD_TYPING_INTERVAL_MS = 8000

/** Channel and thread names are 1-100 characters, docs: channel (channel object). */
export const DISCORD_THREAD_NAME_MAX = 100

/** Every gateway frame: `s` and `t` are null unless `op` is DISPATCH, docs: gateway-events (payload structure). */
export const DiscordGatewayPayloadSchema = z.object({
  op: z.number().int(),
  d: z.unknown(),
  s: z.number().int().nullable().optional(),
  t: z.string().nullable().optional()
})
export type DiscordGatewayPayload = z.infer<typeof DiscordGatewayPayloadSchema>
