import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as z from 'zod'
import { getEndpointFileName } from '../../../shared/agent-hook-listener/transport/endpoint-publication'
import {
  LOCAL_WEBHOOK_HOUR_MS,
  LocalWebhookListener,
  MAX_LOCAL_WEBHOOK_BODY_BYTES,
  localWebhookPort,
  type LocalWebhookCall,
  type LocalWebhookVerdict
} from './local-webhook-listener'
import {
  LOCAL_WEBHOOK_DIR,
  LOCAL_WEBHOOK_EPOCH,
  LocalWebhookStore,
  type LocalHook
} from './local-webhook-store'

const HOOK = 'wh_7Kx2pQ9mZbV4tL1r'
const TOKEN = 'b'.repeat(43)

const CallAnswer = z.object({ ok: z.literal(true), callId: z.string() })
const StateAnswer = z.object({
  ok: z.literal(true),
  port: z.number(),
  stable: z.boolean(),
  hooks: z.array(z.object({ hookId: z.string(), url: z.string() }))
})

const hook = (): LocalHook => ({
  hookId: HOOK,
  token: TOKEN,
  automationId: 'a1',
  botId: 'bot-1',
  epoch: LOCAL_WEBHOOK_EPOCH,
  created: 1
})

let userDataPath: string
let store: LocalWebhookStore
let listener: LocalWebhookListener
let taken: number
let takenSince: number[]
let delivered: LocalWebhookCall[]
let verdict: LocalWebhookVerdict

const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${listener.port() ?? 0}${path}`, { method: 'POST', body, headers })

beforeEach(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-local-webhooks-listener-'))
  store = new LocalWebhookStore(userDataPath)
  await store.load()
  await store.putHook(hook())
  taken = 0
  takenSince = []
  delivered = []
  verdict = 'kept'
  listener = new LocalWebhookListener({
    userDataPath,
    hook: (hookId) => store.hook(hookId),
    taken: (_hookId, since) => {
      takenSince.push(since)
      return taken
    },
    deliver: async (call) => {
      delivered.push(call)
      if (verdict === 'kept') {
        await store.putCall(
          { callId: call.callId, hookId: call.hookId, createdAt: 10 },
          call.envelope
        )
      }
      return verdict
    },
    urls: () => [
      { hookId: HOOK, url: `http://127.0.0.1:${listener.port()}/hook/${HOOK}/${TOKEN}` }
    ],
    now: () => 1_000_000
  })
  await listener.start()
})

afterEach(() => {
  listener.stop()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('this computer’s webhook listener', () => {
  it('binds loopback on the port its profile names, and publishes where it listens', () => {
    expect(listener.listening()).toBe(true)
    expect(listener.port()).toBe(localWebhookPort(userDataPath))
    expect(listener.stable()).toBe(true)
    expect(listener.url(HOOK)).toBe(`http://127.0.0.1:${listener.port()}/hook/${HOOK}`)
    const endpoint = readFileSync(
      join(userDataPath, LOCAL_WEBHOOK_DIR, getEndpointFileName()),
      'utf8'
    )
    expect(endpoint).toContain(`ORCA_LOCAL_WEBHOOK_PORT=${listener.port()}`)
    expect(endpoint).toContain('ORCA_LOCAL_WEBHOOK_TOKEN=')
    expect(endpoint).toContain('ORCA_LOCAL_WEBHOOK_STABLE=1')
  })

  it('falls back to an ephemeral port, and says so, when its own port is taken', async () => {
    const wanted = localWebhookPort(userDataPath)
    // This profile's port, held by something else before this host gets to it.
    listener.stop()
    const squatter = createServer()
    await new Promise<void>((resolve, reject) => {
      squatter.once('error', reject)
      squatter.listen(wanted, '127.0.0.1', resolve)
    })
    const other = new LocalWebhookListener({
      userDataPath,
      hook: () => hook(),
      taken: () => 0,
      deliver: async () => 'kept',
      urls: () => []
    })
    try {
      await other.start()
      expect(other.listening()).toBe(true)
      expect(other.port()).not.toBe(wanted)
      expect(other.stable()).toBe(false)
      const endpoint = readFileSync(
        join(userDataPath, LOCAL_WEBHOOK_DIR, getEndpointFileName()),
        'utf8'
      )
      expect(endpoint).toContain('ORCA_LOCAL_WEBHOOK_STABLE=0')
    } finally {
      other.stop()
      squatter.close()
    }
  })

  it('takes a delivery and answers with the call it kept', async () => {
    const response = await post(`/hook/${HOOK}/${TOKEN}`, JSON.stringify({ action: 'opened' }), {
      'content-type': 'application/json'
    })
    expect(response.status).toBe(200)
    const answer = CallAnswer.parse(await response.json())
    expect(answer.callId).toMatch(/^call_[A-Za-z0-9]{20}$/)
    // Kept before the answer: the body is on disk by the time a 200 could reach the sender.
    expect((await store.envelope(answer.callId))?.body).toEqual({
      kind: 'json',
      value: { action: 'opened' }
    })
    expect(delivered.map((call) => call.callId)).toEqual([answer.callId])
  })

  it('never keeps its own token, or a credential header, as part of the call', async () => {
    const response = await post(`/hook/${HOOK}/${TOKEN}`, 'x', {
      authorization: `Bearer ${TOKEN}`,
      'x-echo': TOKEN
    })
    expect(response.status).toBe(200)
    const { callId } = CallAnswer.parse(await response.json())
    const { headers } = (await store.envelope(callId))!
    expect(JSON.stringify(headers)).not.toContain(TOKEN)
    expect(headers['authorization']).toBeUndefined()
  })

  it('refuses an unknown hook, a wrong token and anything but a POST', async () => {
    expect((await post(`/hook/wh_0000000000000000/${TOKEN}`, 'x')).status).toBe(404)
    expect((await post(`/hook/${HOOK}/${'c'.repeat(43)}`, 'x')).status).toBe(401)
    expect((await post(`/hook/${HOOK}/${TOKEN}/extra`, 'x')).status).toBe(404)
    const read = await fetch(`http://127.0.0.1:${listener.port()}/hook/${HOOK}/${TOKEN}`)
    expect(read.status).toBe(405)
    expect(delivered).toEqual([])
  })

  it('refuses a body over the cap, and a call past the hook’s 200th in an hour', async () => {
    const oversize = await post(
      `/hook/${HOOK}/${TOKEN}`,
      'x'.repeat(MAX_LOCAL_WEBHOOK_BODY_BYTES + 1)
    )
    expect(oversize.status).toBe(413)

    taken = 200
    expect((await post(`/hook/${HOOK}/${TOKEN}`, '{}')).status).toBe(429)
    expect(takenSince).toEqual([
      1_000_000 - LOCAL_WEBHOOK_HOUR_MS,
      1_000_000 - LOCAL_WEBHOOK_HOUR_MS
    ])

    taken = 199
    expect((await post(`/hook/${HOOK}/${TOKEN}`, '{}')).status).toBe(200)
  })

  it('answers 429 when the cap was passed while the body was still arriving', async () => {
    verdict = 'over_cap'
    expect((await post(`/hook/${HOOK}/${TOKEN}`, '{}')).status).toBe(429)
    verdict = 'failed'
    expect((await post(`/hook/${HOOK}/${TOKEN}`, '{}')).status).toBe(500)
  })

  it('answers the discovery route only to the endpoint file’s token', async () => {
    const endpoint = readFileSync(
      join(userDataPath, LOCAL_WEBHOOK_DIR, getEndpointFileName()),
      'utf8'
    )
    const admin = /ORCA_LOCAL_WEBHOOK_TOKEN=(\S+)/.exec(endpoint)?.[1]
    const base = `http://127.0.0.1:${listener.port()}/state`
    expect((await fetch(base)).status).toBe(401)
    expect((await fetch(base, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(401)
    const answer = await fetch(base, { headers: { authorization: `Bearer ${admin}` } })
    expect(answer.status).toBe(200)
    expect(StateAnswer.parse(await answer.json())).toEqual({
      ok: true,
      port: listener.port(),
      stable: true,
      hooks: [{ hookId: HOOK, url: `http://127.0.0.1:${listener.port()}/hook/${HOOK}/${TOKEN}` }]
    })
  })

  it('closes a server whose bind finished after a stop, and can be started again', async () => {
    const fresh = new LocalWebhookListener({
      userDataPath,
      hook: () => hook(),
      taken: () => 0,
      deliver: async () => 'kept',
      urls: () => []
    })
    // Stopped while the port is still being taken: the bind must not leave a server nothing can reach.
    const starting = fresh.start()
    fresh.stop()
    await starting
    expect(fresh.port()).toBe(null)
    // A listener that kept the stale server would return early here and never serve again.
    await fresh.start()
    try {
      expect(fresh.listening()).toBe(true)
      expect(fresh.port()).toBeGreaterThan(0)
    } finally {
      fresh.stop()
    }
  })

  it('removes its endpoint file when it stops, so nothing points at a dead port', async () => {
    const path = join(userDataPath, LOCAL_WEBHOOK_DIR, getEndpointFileName())
    listener.stop()
    expect(listener.listening()).toBe(false)
    expect(listener.url(HOOK)).toBe(null)
    await vi.waitFor(() => expect(() => readFileSync(path)).toThrow())
  })
})
