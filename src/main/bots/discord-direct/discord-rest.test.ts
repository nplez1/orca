import { describe, expect, it } from 'vitest'
import { createDiscordRest } from './discord-rest'
import { DISCORD_API_BASE, DISCORD_USER_AGENT } from './discord-contract'

const TOKEN = 'bot-token-under-test'

type Request = { url: string; init: RequestInit }
type Reply = (request: Request) => Response

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })

const user = { id: '42', username: 'orca', bot: true }

/**
 * A clock that does not advance is what makes a pending block observable: a real one would have
 * elapsed while the recorded sleep returned immediately.
 */
function harness(replies: Reply[]) {
  const requests: Request[] = []
  const sleeps: number[] = []
  let invalidated = 0
  const rest = createDiscordRest({
    token: TOKEN,
    now: () => 1_000_000,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    onTokenInvalid: () => {
      invalidated += 1
    },
    fetchImpl: async (input, init) => {
      const request = { url: String(input), init: init ?? {} }
      requests.push(request)
      const reply = replies.shift()
      if (!reply) {
        throw new Error(`no reply queued for ${request.url}`)
      }
      return reply(request)
    }
  })
  return { rest, requests, sleeps, invalidated: () => invalidated }
}

const rateLimited = (retryAfter: number, global = false): Response =>
  json(429, { message: 'You are being rate limited.', retry_after: retryAfter, global })

describe('the request Discord receives', () => {
  it('sends the bot token, the shared user agent, and a JSON type only when there is a body', async () => {
    const h = harness([() => json(200, user), () => json(200, user)])
    await h.rest.getCurrentUser()
    await h.rest.createMessage('1', { content: 'hi' })

    const [read, write] = h.requests
    const readHeaders = new Headers(read.init.headers)
    const writeHeaders = new Headers(write.init.headers)
    expect(read.url).toBe(`${DISCORD_API_BASE}/users/@me`)
    expect(read.init.method).toBe('GET')
    expect(readHeaders.get('authorization')).toBe(`Bot ${TOKEN}`)
    expect(readHeaders.get('user-agent')).toBe(DISCORD_USER_AGENT)
    expect(readHeaders.get('content-type')).toBeNull()
    expect(write.url).toBe(`${DISCORD_API_BASE}/channels/1/messages`)
    expect(write.init.method).toBe('POST')
    expect(writeHeaders.get('content-type')).toBe('application/json')
    expect(write.init.body).toBe(JSON.stringify({ content: 'hi' }))
  })

  it('posts an upload as multipart with payload_json and files[0]', async () => {
    const h = harness([() => json(200, { id: '7', channel_id: '1' })])
    await h.rest.uploadFile('1', {
      content: 'a file',
      filename: 'shot.png',
      data: new Uint8Array([1, 2, 3]),
      reference: '6'
    })

    const form = h.requests[0].init.body as FormData
    expect(new Headers(h.requests[0].init.headers).get('content-type')).toBeNull()
    expect(form.get('files[0]')).toBeInstanceOf(Blob)
    expect((form.get('files[0]') as File).name).toBe('shot.png')
    expect(JSON.parse(String(form.get('payload_json')))).toEqual({
      content: 'a file',
      message_reference: { message_id: '6', fail_if_not_exists: false },
      attachments: [{ id: 0, filename: 'shot.png' }]
    })
  })
})

describe('a rate limit is waited out', () => {
  it('turns a fractional retry_after into milliseconds and then succeeds', async () => {
    const h = harness([() => rateLimited(0.25), () => json(200, user)])
    const result = await h.rest.getCurrentUser()

    expect(result).toEqual({ ok: true, body: user })
    expect(h.sleeps).toEqual([250])
    expect(h.requests).toHaveLength(2)
  })

  it('waits 1700 ms for retry_after 1.7', async () => {
    const h = harness([() => rateLimited(1.7), () => json(200, user)])
    await h.rest.getCurrentUser()
    expect(h.sleeps).toEqual([1700])
  })

  it('falls back to the Retry-After header when the 429 body is not JSON', async () => {
    const h = harness([
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }),
      () => json(200, user)
    ])
    await h.rest.getCurrentUser()
    expect(h.sleeps).toEqual([2000])
  })

  it('gives up as rate_limited after three 429s rather than retrying forever', async () => {
    const h = harness([() => rateLimited(0.25), () => rateLimited(0.25), () => rateLimited(0.25)])
    const result = await h.rest.getCurrentUser()

    expect(result).toEqual({ ok: false, code: 'rate_limited', retryAfterMs: 250, status: 429 })
    expect(h.requests).toHaveLength(3)
    expect(h.sleeps).toEqual([250, 250])
  })

  it('makes a global 429 block a different route on the same token', async () => {
    const h = harness([() => rateLimited(2, true), () => json(200, []), () => json(200, user)])
    await h.rest.getMessages('1')
    await h.rest.getCurrentUser()

    expect(h.sleeps).toEqual([2000, 2000])
    expect(h.requests[2].url).toBe(`${DISCORD_API_BASE}/users/@me`)
  })

  it('waits out an exhausted bucket on its next call, and leaves another bucket alone', async () => {
    const h = harness([
      () => json(200, [], { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '2' }),
      () => json(200, []),
      () => json(200, [])
    ])
    await h.rest.getMessages('1')
    expect(h.sleeps).toEqual([])

    await h.rest.getMessages('1')
    expect(h.sleeps).toEqual([2000])

    await h.rest.getMessages('2')
    expect(h.sleeps).toEqual([2000])
  })
})

describe('the statuses that are never retried', () => {
  it('reports a 401 as token_invalid, notifies once, and stops', async () => {
    const h = harness([() => json(401, { message: 'Invalid token' })])
    const result = await h.rest.getCurrentUser()

    expect(result).toEqual({
      ok: false,
      code: 'token_invalid',
      status: 401,
      message: 'Invalid token'
    })
    expect(h.invalidated()).toBe(1)
    expect(h.requests).toHaveLength(1)
    expect(h.sleeps).toEqual([])
  })

  it('reports 403 as forbidden and 404 as not_found without a second request', async () => {
    const h = harness([
      () => json(403, { message: 'Missing Access' }),
      () => json(404, { message: 'Unknown Channel' })
    ])

    expect(await h.rest.getMessages('1')).toEqual({
      ok: false,
      code: 'forbidden',
      status: 403,
      message: 'Missing Access'
    })
    expect(await h.rest.getMessages('2')).toEqual({
      ok: false,
      code: 'not_found',
      status: 404,
      message: 'Unknown Channel'
    })
    expect(h.requests).toHaveLength(2)
    expect(h.sleeps).toEqual([])
  })

  it('reports any other status as failed, with the status and no retry', async () => {
    const h = harness([() => json(400, { message: 'Bad Request' })])
    expect(await h.rest.triggerTyping('1')).toEqual({
      ok: false,
      code: 'failed',
      status: 400,
      message: 'Bad Request'
    })
    expect(h.requests).toHaveLength(1)
  })

  it('never echoes the token in what it returns', async () => {
    const h = harness([() => json(400, { message: `Invalid OAuth2 access token ${TOKEN}` })])
    const result = await h.rest.getCurrentUser()

    expect(JSON.stringify(result)).not.toContain(TOKEN)
    expect(result).toMatchObject({ message: 'Invalid OAuth2 access token [redacted]' })
  })
})
