import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as z from 'zod'
import { getEndpointFileName } from '../../../shared/agent-hook-listener/transport/endpoint-publication'
import {
  LOCAL_WEBHOOK_HOUR_MS,
  LocalWebhookListener,
  MAX_LOCAL_WEBHOOK_BODY_BYTES,
  type LocalWebhookCall
} from './local-webhook-listener'
import {
  LOCAL_WEBHOOK_DIR,
  LOCAL_WEBHOOK_EPOCH,
  LocalWebhookStore,
  type LocalHook
} from './local-webhook-store'

const HOOK = 'wh_7Kx2pQ9mZbV4tL1r'
const TOKEN = 'b'.repeat(43)

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

const CallAnswer = z.object({ ok: z.literal(true), callId: z.string() })
const StateAnswer = z.object({
  ok: z.literal(true),
  port: z.number(),
  hooks: z.array(z.object({ hookId: z.string(), url: z.string() }))
})

const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${listener.port() ?? 0}${path}`, { method: 'POST', body, headers })

beforeEach(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-local-webhooks-listener-'))
  store = new LocalWebhookStore(userDataPath)
  store.putHook(hook())
  taken = 0
  takenSince = []
  delivered = []
  listener = new LocalWebhookListener({
    userDataPath,
    hook: (hookId) => store.hook(hookId),
    taken: (_hookId, since) => {
      takenSince.push(since)
      return taken
    },
    deliver: (call) => {
      delivered.push(call)
      store.putCall({ callId: call.callId, hookId: call.hookId, envelope: call.envelope })
      return true
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
  it('binds loopback on an ephemeral port and publishes where it listens', () => {
    expect(listener.listening()).toBe(true)
    expect(listener.url(HOOK)).toBe(`http://127.0.0.1:${listener.port()}/hook/${HOOK}`)
    const endpoint = readFileSync(
      join(userDataPath, LOCAL_WEBHOOK_DIR, getEndpointFileName()),
      'utf8'
    )
    expect(endpoint).toContain(`ORCA_LOCAL_WEBHOOK_PORT=${listener.port()}`)
    expect(endpoint).toContain('ORCA_LOCAL_WEBHOOK_TOKEN=')
  })

  it('takes a delivery and answers with the call it kept', async () => {
    const response = await post(`/hook/${HOOK}/${TOKEN}`, JSON.stringify({ action: 'opened' }), {
      'content-type': 'application/json'
    })
    expect(response.status).toBe(200)
    const answer = CallAnswer.parse(await response.json())
    expect(answer.ok).toBe(true)
    expect(answer.callId).toMatch(/^call_[A-Za-z0-9]{20}$/)
    // Kept before the answer: the body is on disk by the time a 200 could reach the sender.
    expect(store.call(answer.callId)?.envelope.body).toEqual({
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
    const { headers } = store.call(callId)!.envelope
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
      hooks: [{ hookId: HOOK, url: `http://127.0.0.1:${listener.port()}/hook/${HOOK}/${TOKEN}` }]
    })
  })

  it('removes its endpoint file when it stops, so nothing points at a dead port', () => {
    const path = join(userDataPath, LOCAL_WEBHOOK_DIR, getEndpointFileName())
    listener.stop()
    expect(listener.listening()).toBe(false)
    expect(() => readFileSync(path)).toThrow()
  })
})
