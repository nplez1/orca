// The Discord REST client: one bot token, one bucket table, and a wait instead of a retry storm.
// Discord counts 401/403/429 against an IP's invalid-request budget (10,000 per 10 minutes) and
// answers a burst with a Cloudflare ban, so a 429 is the only status ever retried,
// docs: rate-limits (invalid request limit aka cloudflare bans).
import { DISCORD_API_BASE, DISCORD_USER_AGENT } from './discord-contract'

export type DiscordRestErrorCode =
  | 'rate_limited'
  | 'token_invalid'
  | 'forbidden'
  | 'not_found'
  | 'failed'

export type DiscordRestFailure = {
  ok: false
  code: DiscordRestErrorCode
  /** Set on `rate_limited`: the wait Discord asked for, already in ms. */
  retryAfterMs?: number
  status?: number
  /** Discord's own `message`, redacted and bounded; never a header, never the token. */
  message?: string
}
export type DiscordRestSuccess<T> = { ok: true; body: T }
export type DiscordRestResult<T> = DiscordRestSuccess<T> | DiscordRestFailure

/** `GET /applications/@me`; only the fields a connector reads are typed. */
export type DiscordApplication = { id: string; name: string; bot_public?: boolean }

/** `GET /users/@me`. */
export type DiscordUser = {
  id: string
  username: string
  global_name?: string | null
  bot?: boolean
}

/** `GET /gateway/bot`, docs: gateway (get gateway bot). */
export type DiscordSessionStartLimit = {
  total: number
  remaining: number
  /** Milliseconds — the one duration Discord sends in ms rather than seconds. */
  reset_after: number
  /** Identifies allowed per 5 seconds. */
  max_concurrency: number
}
export type DiscordGatewayInfo = {
  url: string
  shards: number
  session_start_limit: DiscordSessionStartLimit
}

/** docs: message (message reference structure); only `message_id` is required to reply. */
export type DiscordMessageReference = {
  message_id?: string
  channel_id?: string
  fail_if_not_exists?: boolean
}

/** docs: message (create message json/form params). */
export type DiscordCreateMessage = {
  content?: string
  /** Up to 25 characters; echoed on the Message Create event. */
  nonce?: string | number
  /** With `nonce`, a repeat of the same nonce returns the first message instead of sending again. */
  enforce_nonce?: boolean
  /** docs: message (allowed mentions object). */
  allowed_mentions?: {
    parse?: ('roles' | 'users' | 'everyone')[]
    roles?: string[]
    users?: string[]
    replied_user?: boolean
  }
  message_reference?: DiscordMessageReference
  /** `id` must match the `n` in `files[n]`, docs: message (attachment request structure). */
  attachments?: { id: number; filename?: string }[]
}

/** docs: message (message object), cut to what a connector reads. */
export type DiscordMessage = {
  id: string
  channel_id: string
  guild_id?: string
  author: { id: string; username: string; bot?: boolean }
  content: string
  timestamp: string
  type: number
  message_reference?: DiscordMessageReference
}

/** docs: channel (channel object), cut to what a thread reply needs. */
export type DiscordChannel = { id: string; type: number; name?: string; parent_id?: string | null }

/** A file plus the content it is sent with; `reference` is the message it answers, if any. */
export type DiscordUpload = {
  content?: string
  filename: string
  data: Uint8Array<ArrayBuffer>
  reference?: string
}

export type DiscordRestDeps = {
  token: string
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Called once per 401 so the connector can stop using a token Discord has rejected. */
  onTokenInvalid?: () => void
}

type DiscordRestPromise<T> = Promise<DiscordRestResult<T>>

export type DiscordRest = {
  getApplicationInfo(): DiscordRestPromise<DiscordApplication>
  getCurrentUser(): DiscordRestPromise<DiscordUser>
  getGatewayUrl(): DiscordRestPromise<DiscordGatewayInfo>
  getMessages(
    channelId: string,
    options?: { after?: string; limit?: number }
  ): DiscordRestPromise<DiscordMessage[]>
  createMessage(channelId: string, body: DiscordCreateMessage): DiscordRestPromise<DiscordMessage>
  startThread(
    channelId: string,
    messageId: string,
    name: string
  ): DiscordRestPromise<DiscordChannel>
  triggerTyping(channelId: string): DiscordRestPromise<null>
  uploadFile(channelId: string, file: DiscordUpload): DiscordRestPromise<DiscordMessage>
}

/** Attempts per call, the first included. A 429 carries its own wait, so nothing else is retried. */
const DISCORD_MAX_ATTEMPTS = 3

/** `limit` is 1-100 and defaults to 50, docs: message (get channel messages query string params). */
const DISCORD_MESSAGE_PAGE_MAX = 100
const DISCORD_MESSAGE_PAGE_DEFAULT = 50

/** Used only when a 429 carries neither a body nor any header naming a wait. */
const DISCORD_RATE_LIMIT_FALLBACK_MS = 1000

type DiscordMethod = 'GET' | 'POST'

/** `template` is the bucket's identity when Discord has not named one, and `major` is the top-level
 *  resource per-route limits are calculated on, docs: rate-limits (per-route rate limits). */
type DiscordRoute = { method: DiscordMethod; path: string; template?: string; major?: string }

/** The statuses that are never retried, each mapped to what the caller is told. */
const NEVER_RETRIED: Record<number, DiscordRestErrorCode> = {
  401: 'token_invalid',
  403: 'forbidden',
  404: 'not_found'
}

type DiscordRateLimitBody = { message?: unknown; retry_after?: unknown; global?: unknown }

function channelRoute(
  method: DiscordMethod,
  channelId: string,
  suffix: string,
  suffixTemplate = suffix
): DiscordRoute {
  const path = `/channels/${encodeURIComponent(channelId)}${suffix}`
  const template = `${method} /channels/:channel_id${suffixTemplate}`
  return { method, path, template, major: `channel:${channelId}` }
}

/** `retry_after` is fractional seconds, docs: rate-limits (rate limit response structure), so a
 *  0.25 s wait is 250 ms and never 0. */
function retryAfterMs(seconds: number): number {
  return Math.ceil(seconds * 1000)
}

function headerSeconds(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name)
  const seconds = raw === null ? Number.NaN : Number.parseFloat(raw)
  return Number.isFinite(seconds) ? seconds : undefined
}

function failure(
  code: DiscordRestErrorCode,
  status?: number,
  message?: string
): DiscordRestFailure {
  return { ok: false, code, status, message }
}

/** One bounded line of Discord's own error text, with anything token-shaped already scrubbed. */
function errorText(
  body: DiscordRateLimitBody,
  redact: (text: string) => string
): string | undefined {
  return typeof body.message === 'string'
    ? redact(body.message).replace(/\s+/g, ' ').trim().slice(0, 200)
    : undefined
}

/** A 429's wait and scope; the body is authoritative, the headers are the documented fallback. */
function rateLimit(
  body: DiscordRateLimitBody,
  headers: Headers
): { waitMs: number; global: boolean } {
  const retryAfter = typeof body.retry_after === 'number' ? body.retry_after : Number.NaN
  const seconds =
    (Number.isFinite(retryAfter) ? retryAfter : undefined) ??
    headerSeconds(headers, 'retry-after') ??
    headerSeconds(headers, 'x-ratelimit-reset-after')
  const global = body.global === true || headers.get('x-ratelimit-global')?.toLowerCase() === 'true'
  const waitMs = seconds === undefined ? DISCORD_RATE_LIMIT_FALLBACK_MS : retryAfterMs(seconds)
  return { waitMs, global }
}

/** A response body, or nothing when it is empty or not JSON — Discord sends either on a 429. */
async function readErrorBody(response: Response): Promise<DiscordRateLimitBody> {
  try {
    return (await response.json()) as DiscordRateLimitBody
  } catch {
    return {}
  }
}

export function createDiscordRest(deps: DiscordRestDeps): DiscordRest {
  const fetchImpl: typeof fetch = deps.fetchImpl ?? ((input, init) => fetch(input, init))
  const now = deps.now ?? (() => Date.now())
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const token = deps.token

  /** Epoch ms every route waits for after a `global: true` 429: one block for the whole token. */
  let globalBlockedUntil = 0
  /** Bucket key -> epoch ms that bucket resets at. */
  const bucketResets = new Map<string, number>()
  /** Route key -> the `X-RateLimit-Bucket` Discord named, so routes sharing a limit share the wait. */
  const bucketIds = new Map<string, string>()

  const redact = (text: string): string =>
    token.length === 0 ? text : text.split(token).join('[redacted]')
  /** Bucket identity: the id Discord named, else the route template, always with its major param. */
  const bucketKey = (route: DiscordRoute, bucketId?: string): string =>
    `${bucketId ?? route.template ?? route.path}|${route.major ?? ''}`

  function block(key: string, until: number): void {
    bucketResets.set(key, Math.max(until, bucketResets.get(key) ?? 0))
  }

  /** Spent before every attempt, so an exhausted bucket is waited out instead of fired into a 429. */
  async function waitForBucket(route: DiscordRoute): Promise<void> {
    const key = bucketKey(route, bucketIds.get(bucketKey(route)))
    const remainingMs = Math.max(globalBlockedUntil, bucketResets.get(key) ?? 0) - now()
    if (remainingMs > 0) {
      await sleep(Math.ceil(remainingMs))
    }
  }

  async function send<T>(
    route: DiscordRoute,
    init: { body?: unknown; form?: FormData } = {}
  ): Promise<DiscordRestResult<T>> {
    for (let attempt = 1; attempt <= DISCORD_MAX_ATTEMPTS; attempt += 1) {
      await waitForBucket(route)
      const headers: Record<string, string> = {
        authorization: `Bot ${token}`,
        'user-agent': DISCORD_USER_AGENT
      }
      if (init.body !== undefined) {
        headers['content-type'] = 'application/json'
      }
      // fetch writes the multipart boundary itself; naming the type here would drop it.
      const body: BodyInit | undefined =
        init.form ?? (init.body === undefined ? undefined : JSON.stringify(init.body))

      let response: Response
      try {
        response = await fetchImpl(`${DISCORD_API_BASE}${route.path}`, {
          method: route.method,
          headers,
          body
        })
      } catch {
        return failure('failed', undefined, 'the request did not reach Discord')
      }

      const named = response.headers.get('x-ratelimit-bucket')
      if (named !== null) {
        bucketIds.set(bucketKey(route), named)
      }
      const key = bucketKey(route, named ?? undefined)

      if (response.status === 429) {
        const limit = rateLimit(await readErrorBody(response), response.headers)
        // Recorded, not slept: the next attempt's pre-flight waits once, never twice.
        block(key, now() + limit.waitMs)
        if (limit.global) {
          globalBlockedUntil = Math.max(globalBlockedUntil, now() + limit.waitMs)
        }
        if (attempt === DISCORD_MAX_ATTEMPTS) {
          return { ok: false, code: 'rate_limited', retryAfterMs: limit.waitMs, status: 429 }
        }
        continue
      }

      if (response.headers.get('x-ratelimit-remaining') === '0') {
        const resetAfter = headerSeconds(response.headers, 'x-ratelimit-reset-after')
        if (resetAfter !== undefined) {
          block(key, now() + retryAfterMs(resetAfter))
        }
      }

      const neverRetried = NEVER_RETRIED[response.status]
      if (neverRetried !== undefined || !response.ok) {
        const code = neverRetried ?? 'failed'
        if (code === 'token_invalid') {
          deps.onTokenInvalid?.()
        }
        const message = errorText(await readErrorBody(response), redact)
        return failure(code, response.status, message)
      }
      if (response.status === 204) {
        return { ok: true, body: null as T }
      }
      try {
        return { ok: true, body: (await response.json()) as T }
      } catch {
        return failure('failed', response.status, 'body was not JSON')
      }
    }
    // Unreachable: the last attempt always returns.
    return failure('rate_limited')
  }

  return {
    getApplicationInfo: () =>
      send<DiscordApplication>({ method: 'GET', path: '/applications/@me' }),

    getCurrentUser: () => send<DiscordUser>({ method: 'GET', path: '/users/@me' }),

    getGatewayUrl: () => send<DiscordGatewayInfo>({ method: 'GET', path: '/gateway/bot' }),

    getMessages: (channelId, options = {}) => {
      const route = channelRoute('GET', channelId, '/messages')
      const query = new URLSearchParams()
      if (options.after !== undefined) {
        query.set('after', options.after)
      }
      const limit = Math.min(
        Math.max(Math.trunc(options.limit ?? DISCORD_MESSAGE_PAGE_DEFAULT), 1),
        DISCORD_MESSAGE_PAGE_MAX
      )
      query.set('limit', String(limit))
      // The query is not part of the bucket: the route template stays query-free.
      return send<DiscordMessage[]>({ ...route, path: `${route.path}?${query}` })
    },

    createMessage: (channelId, body) =>
      send<DiscordMessage>(channelRoute('POST', channelId, '/messages'), { body }),

    startThread: (channelId, messageId, name) =>
      send<DiscordChannel>(
        channelRoute(
          'POST',
          channelId,
          `/messages/${encodeURIComponent(messageId)}/threads`,
          '/messages/:message_id/threads'
        ),
        { body: { name } }
      ),

    triggerTyping: (channelId) => send<null>(channelRoute('POST', channelId, '/typing')),

    uploadFile: (channelId, file) => {
      const payload: DiscordCreateMessage = { attachments: [{ id: 0, filename: file.filename }] }
      if (file.content !== undefined) {
        payload.content = file.content
      }
      if (file.reference !== undefined) {
        // A reply whose source is gone still sends, as a normal message.
        payload.message_reference = { message_id: file.reference, fail_if_not_exists: false }
      }
      const form = new FormData()
      form.append('payload_json', JSON.stringify(payload))
      // `files[n]` with `n` matching the attachment's id, docs: message (create message json/form params).
      form.append('files[0]', new Blob([file.data]), file.filename)
      return send<DiscordMessage>(channelRoute('POST', channelId, '/messages'), { form })
    }
  }
}
