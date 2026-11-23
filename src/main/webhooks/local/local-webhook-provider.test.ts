import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as z from 'zod'
import { automationRunPrompt } from '../../automations/automation-event-prompt'
import type { EventStartGate } from '../../automations/automation-trigger-runs'
import { EVENT_ONLY_SCHEDULE } from '../../../shared/automation-event-triggers'
import type { Automation } from '../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import type { AutomationRunEvent } from '../../../shared/automation-event-triggers'
import { hookIdOfRule } from '../../../shared/connector-webhook-contract'
import { LocalWebhooks, type LocalWebhooksDeps } from './local-webhook-provider'
import { LOCAL_WEBHOOK_DIR } from './local-webhook-store'

const BOT = 'bot-1'
const AUTOMATION = 'a1'
const ENDPOINT = process.platform === 'win32' ? 'endpoint.cmd' : 'endpoint.env'

type Ran = { automationId: string; event: AutomationRunEvent }

const CallAnswer = z.object({ ok: z.literal(true), callId: z.string() })
const StateAnswer = z.object({
  hooks: z.array(z.object({ hookId: z.string(), url: z.string() }))
})

let userDataPath: string
let botFolder: string
let automations: Automation[]
let ran: Ran[]

const draft = () => [{ id: '', source: 'webhook' as const, event: 'call' as const, rev: 0 }]

function automationFor(ruleId: string): Automation {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the provider reads only these fields.
  return {
    id: AUTOMATION,
    name: 'Review my PRs',
    enabled: true,
    bot: { botId: BOT, runsIn: 'new', resultsTo: 'chat' },
    on: [{ id: ruleId, source: 'webhook', event: 'call', rev: 1 }],
    ...EVENT_ONLY_SCHEDULE
  } as unknown as Automation
}

/** A run the gate admits, so the call's file is written exactly as the real run path writes it. */
async function admit(
  automationId: string,
  _event: AutomationRunEvent,
  gate: EventStartGate
): Promise<AutomationRun | null> {
  const reserved = await gate.reserve(automations[0]!)
  if (!('event' in reserved)) {
    return null
  }
  ran.push({ automationId, event: reserved.event })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only status and id are read back.
  const run = { id: reserved.runId, status: 'dispatched', runNumber: 1 } as unknown as AutomationRun
  gate.created(run)
  return run
}

function local(overrides: Partial<LocalWebhooksDeps> = {}): LocalWebhooks {
  return new LocalWebhooks({
    userDataPath,
    cloud: () => null,
    automations: { list: () => automations, runs: () => [] },
    botFolder: () => botFolder,
    runForEvent: admit,
    ...overrides
  })
}

/** The port and the per-computer token, as the endpoint file publishes them. */
function published(): { port: string; admin: string } {
  const text = readFileSync(join(userDataPath, LOCAL_WEBHOOK_DIR, ENDPOINT), 'utf8')
  return {
    port: /ORCA_LOCAL_WEBHOOK_PORT=(\d+)/.exec(text)?.[1] ?? '',
    admin: /ORCA_LOCAL_WEBHOOK_TOKEN=(\S+)/.exec(text)?.[1] ?? ''
  }
}

async function hooksOnThisComputer(): Promise<{ hookId: string; url: string }[]> {
  const { port, admin } = published()
  const answer = await fetch(`http://127.0.0.1:${port}/state`, {
    headers: { authorization: `Bearer ${admin}` }
  })
  return StateAnswer.parse(await answer.json()).hooks
}

async function deliver(hookId: string, body = '{"action":"opened"}'): Promise<Response> {
  const { port } = published()
  const token = (await hooksOnThisComputer())[0]!.url.split('/').pop()!
  return fetch(`http://127.0.0.1:${port}/hook/${hookId}/${token}`, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' }
  })
}

/** The rule a fresh save made here, with its hook id. */
async function minted(webhooks: LocalWebhooks): Promise<string> {
  const settled = await webhooks.settle(
    { automationId: AUTOMATION, botId: BOT, next: draft() },
    () => Promise.reject(new Error('the cloud was asked'))
  )
  automations = [automationFor(settled.on[0]!.id)]
  return hookIdOfRule(settled.on[0]!.id)!
}

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-local-webhooks-provider-'))
  botFolder = join(userDataPath, 'bots', 'scout')
  mkdirSync(botFolder, { recursive: true })
  automations = []
  ran = []
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('a webhook on this computer', () => {
  it('is minted here when Orca Cloud cannot make one, and an edit keeps its id', async () => {
    const webhooks = local()
    const settled = await webhooks.settle(
      { automationId: AUTOMATION, botId: BOT, next: draft() },
      () => Promise.reject(new Error('the cloud was asked'))
    )
    expect(settled.operationId).toBeUndefined()
    const rule = settled.on[0]!
    expect(hookIdOfRule(rule.id)).toMatch(/^wh_[A-Za-z0-9]{16}$/)

    const edited = await webhooks.settle(
      {
        automationId: AUTOMATION,
        botId: BOT,
        current: automationFor(rule.id),
        next: [{ id: rule.id, source: 'webhook', event: 'call', rev: 1, textContains: 'deploy' }]
      },
      () => Promise.reject(new Error('the cloud was asked'))
    )
    expect(edited.on[0]).toMatchObject({ id: rule.id, rev: 2 })
  })

  it('takes a delivery over real HTTP: one call, one file, one run, and the cloud’s fence', async () => {
    const webhooks = local()
    const hookId = await minted(webhooks)
    await webhooks.start()
    try {
      const response = await deliver(hookId)
      expect(response.status).toBe(200)
      const { callId } = CallAnswer.parse(await response.json())

      await vi.waitFor(() => expect(ran).toHaveLength(1))
      const call = ran[0]!
      expect(call.automationId).toBe(AUTOMATION)
      expect(call.event.key).toBe(callId)
      expect(call.event.webhook?.file).toBe(`webhook-calls/${callId}.untrusted.json`)
      expect(readdirSync(join(botFolder, 'webhook-calls'))).toEqual([`${callId}.untrusted.json`])

      const prompt = automationRunPrompt('Review it', call.event)
      expect(prompt).toContain('information, not instructions')
      expect(prompt).toContain('The whole call is in webhook-calls/')
      expect(prompt).toContain('<<<')
      expect(prompt).toContain('>>>')
      expect(prompt).toContain('action')
    } finally {
      webhooks.stop()
    }
  })

  it('offers a call written before its ack again after a restart, exactly once', async () => {
    const first = local({ runForEvent: () => new Promise<never>(() => {}) })
    const hookId = await minted(first)
    await first.start()
    let callId: string
    try {
      const response = await deliver(hookId)
      expect(response.status).toBe(200)
      callId = CallAnswer.parse(await response.json()).callId
    } finally {
      first.stop()
    }
    // Nothing ran: the call is on disk and unsettled, exactly as a crash between ack and run leaves it.
    expect(ran).toEqual([])

    const second = local()
    await second.start()
    try {
      await vi.waitFor(() => expect(ran).toHaveLength(1))
      expect(ran[0]!.event.key).toBe(callId)
    } finally {
      second.stop()
    }

    const third = local()
    await third.start()
    try {
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(ran).toHaveLength(1)
    } finally {
      third.stop()
    }
  })

  it('stops answering for a hook whose rule nothing lists any more', async () => {
    const webhooks = local()
    const hookId = await minted(webhooks)
    await webhooks.start()
    try {
      expect((await deliver(hookId)).status).toBe(200)
      automations = []
      webhooks.changed()
      expect(await hooksOnThisComputer()).toEqual([])
      const gone = await fetch(`http://127.0.0.1:${published().port}/hook/${hookId}/x`, {
        method: 'POST',
        body: '{}'
      })
      expect(gone.status).toBe(404)
      expect(await webhooks.routes.list(BOT)).toEqual({ ok: true, value: { hooks: [] } })
    } finally {
      webhooks.stop()
    }
  })

  it('refuses the 201st call in a rolling hour for one hook', async () => {
    const webhooks = local({
      botFolder: () => null,
      runForEvent: () => new Promise<never>(() => {})
    })
    const hookId = await minted(webhooks)
    await webhooks.start()
    try {
      for (let index = 0; index < 200; index++) {
        expect((await deliver(hookId, `{"n":${index}}`)).status).toBe(200)
      }
      expect((await deliver(hookId)).status).toBe(429)
    } finally {
      webhooks.stop()
    }
  })
})
