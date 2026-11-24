import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as z from 'zod'
import { automationRunPrompt } from '../../automations/automation-event-prompt'
import { makeTestBot } from '../../bots/bot.test-fixture'
import type { EventStartGate } from '../../automations/automation-trigger-runs'
import { EVENT_ONLY_SCHEDULE } from '../../../shared/automation-event-triggers'
import type { Automation } from '../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import type {
  AutomationEventTrigger,
  AutomationRunEvent
} from '../../../shared/automation-event-triggers'
import { WebhookHostLedger } from '../webhook-host-ledger'
import { hookIdOfRule } from '../../../shared/connector-webhook-contract'
import { botEventTriggerRefusal } from '../../../shared/bot-event-sources'
import { AutomationWebhookSaves } from '../automation-webhook-saves'
import { LocalWebhookHostService } from './local-webhook-host'
import {
  LOCAL_LEDGER_ACCOUNT,
  LocalWebhooks,
  type LocalWebhooksDeps
} from './local-webhook-provider'
import type { ConnectorCloudStatus } from '../../../shared/bots/connector-cloud-status'
import { localWebhookPort } from './local-webhook-listener'
import { LOCAL_MINT_GRACE_MS, LOCAL_WEBHOOK_DIR, LocalWebhookStore } from './local-webhook-store'

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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only status and id are read.
  const run = { id: reserved.runId, status: 'dispatched', runNumber: 1 } as unknown as AutomationRun
  gate.created(run)
  return run
}

/** A host with no Orca Cloud: local hooks only, which is the case this route exists for. */
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

/** The complete URL of one of this host's hooks, token and all, as its card names it. */
async function urlOf(webhooks: LocalWebhooks, hookId: string): Promise<string> {
  const answer = await webhooks.routes.get(hookId)
  if (!answer?.ok) {
    throw new Error('the card did not answer')
  }
  return answer.value.url
}

function post(url: string, body: string): Promise<Response> {
  return fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json' } })
}

async function deliver(
  webhooks: LocalWebhooks,
  hookId: string,
  body = '{"action":"opened"}'
): Promise<Response> {
  return post(await urlOf(webhooks, hookId), body)
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
      const response = await deliver(webhooks, hookId)
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
      const response = await deliver(first, hookId)
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

    // It was started once, so the third start has nothing left to offer: a state, not a wait.
    const ledger = new WebhookHostLedger(join(userDataPath, LOCAL_WEBHOOK_DIR), () => {
      return LOCAL_LEDGER_ACCOUNT
    })
    expect(ledger.calls().map((call) => call.state)).toEqual(['started'])
    const third = local()
    await third.start()
    third.stop()
    expect(ran).toHaveLength(1)
  })

  it('serves and replays even when it cannot publish where it listens', async () => {
    // The endpoint file is discovery; a directory sitting where it belongs makes writing it fail.
    mkdirSync(join(userDataPath, LOCAL_WEBHOOK_DIR, ENDPOINT), { recursive: true })
    const first = local({ runForEvent: () => new Promise<never>(() => {}) })
    const hookId = await minted(first)
    await expect(first.start()).resolves.toBeUndefined()
    expect((await deliver(first, hookId)).status).toBe(200)
    first.stop()

    // The call was kept, so the next start still offers it, with no endpoint file to read either.
    const second = local()
    await second.start()
    await vi.waitFor(() => expect(ran).toHaveLength(1))
    second.stop()
  })

  it('stops answering for a hook whose rule nothing lists any more', async () => {
    const webhooks = local()
    const hookId = await minted(webhooks)
    await webhooks.start()
    try {
      expect((await deliver(webhooks, hookId)).status).toBe(200)
      automations = []
      await webhooks.changed()
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

  it('keeps a freshly minted hook while its automation is still being saved', async () => {
    const webhooks = local()
    const settled = await webhooks.settle(
      { automationId: AUTOMATION, botId: BOT, next: draft() },
      () => Promise.reject(new Error('the cloud was asked'))
    )
    // The save has not landed: nothing lists this rule yet, and every change event runs changed().
    await webhooks.start()
    try {
      await webhooks.changed()
      expect(webhooks.holdsLocally(hookIdOfRule(settled.on[0]!.id)!)).toBe(true)
      automations = [automationFor(settled.on[0]!.id)]
      await webhooks.changed()
      expect(webhooks.holdsLocally(hookIdOfRule(settled.on[0]!.id)!)).toBe(true)
    } finally {
      webhooks.stop()
    }
  })

  it('gives up a mint whose save never landed, once its grace is over', async () => {
    let now = 1_000
    const webhooks = local({ now: () => now })
    const settled = await webhooks.settle(
      { automationId: AUTOMATION, botId: BOT, next: draft() },
      () => Promise.reject(new Error('the cloud was asked'))
    )
    const hookId = hookIdOfRule(settled.on[0]!.id)!
    now += LOCAL_MINT_GRACE_MS + 1
    await webhooks.changed()
    expect(webhooks.holdsLocally(hookId)).toBe(false)
    // Dropped means dropped: the store holds neither the hook nor its intent, so nothing can name it
    // again and the listener answers 404 for it.
    const store = new LocalWebhookStore(userDataPath)
    await store.load()
    expect(store.hooks()).toEqual([])
    expect(store.intents()).toEqual([])
  })

  it('binds even when the store cannot be brought up to date', async () => {
    // A hook nothing lists, so the change has work to do; a listing that throws makes that work fail.
    mkdirSync(join(userDataPath, LOCAL_WEBHOOK_DIR), { recursive: true })
    writeFileSync(
      join(userDataPath, LOCAL_WEBHOOK_DIR, 'local-webhooks.json'),
      JSON.stringify({
        hooks: [
          {
            hookId: 'wh_0000000000000003',
            token: 't'.repeat(43),
            automationId: 'gone',
            botId: BOT,
            epoch: 1,
            created: 1
          }
        ],
        calls: [],
        intents: []
      })
    )
    const webhooks = local({
      automations: {
        list: () => {
          throw new Error('the store is not ready')
        },
        runs: () => []
      }
    })
    await expect(webhooks.start()).resolves.toBeUndefined()
    try {
      // The listener is up regardless: replay is not the socket's business, nor the socket replay's.
      expect(readFileSync(join(userDataPath, LOCAL_WEBHOOK_DIR, ENDPOINT), 'utf8')).toContain(
        'ORCA_LOCAL_WEBHOOK_PORT='
      )
    } finally {
      webhooks.stop()
    }
  })

  it('answers for a hook it holds before the index has loaded', async () => {
    const first = local()
    const settled = await first.settle(
      { automationId: AUTOMATION, botId: BOT, next: draft() },
      () => Promise.reject(new Error('the cloud was asked'))
    )
    const hookId = hookIdOfRule(settled.on[0]!.id)!
    // A fresh host reads its ledger synchronously, so a hello built now cannot mistake this hook for
    // Orca Cloud's and list its id and filters to the cloud.
    const second = local()
    expect(second.holdsLocally(hookId)).toBe(true)
    expect(second.servesLocally({ source: 'webhook', id: settled.on[0]!.id })).toBe(true)
    second.stop()
  })

  it('refuses the 201st call in a rolling hour, however the calls arrive', async () => {
    const webhooks = local({
      botFolder: () => null,
      runForEvent: () => new Promise<never>(() => {})
    })
    const hookId = await minted(webhooks)
    await webhooks.start()
    try {
      // 199 calls already taken this hour, so four senders arriving together are all but one the cap.
      for (let index = 0; index < 199; index++) {
        expect((await deliver(webhooks, hookId)).status).toBe(200)
      }
      // Every one of them passes the listener's own check while the others' bodies are still arriving.
      const statuses = (
        await Promise.all(Array.from({ length: 4 }, () => deliver(webhooks, hookId)))
      ).map((answer) => answer.status)
      expect(statuses.filter((status) => status === 200)).toHaveLength(1)
      expect(statuses.filter((status) => status === 429)).toHaveLength(3)
    } finally {
      webhooks.stop()
    }
  })
})

describe('a host with both kinds of hook', () => {
  /** A host signed out of a connector cloud it still has: the case a signed-out desktop is in. */
  const signedOutCloud = () => ({
    call: async () => {
      throw new Error('a signed-out host calls nothing')
    },
    cloudFeatures: () => null,
    withConnection: async <T>(run: () => Promise<T>) => run(),
    status: () => 'signed-out' as const
  })

  /** A host signed in to a cloud that does not take webhooks: the case N2 is about. */
  const cloudWithoutWebhooks = () => ({
    call: async () => {
      throw new Error('this test never reaches the cloud')
    },
    cloudFeatures: () => new Set<string>(),
    withConnection: async <T>(run: () => Promise<T>) => run(),
    status: () => 'ok' as const
  })

  /** What the host asks a cloud: its features, and whether it is signed out. */
  type TestCloud = {
    call: () => Promise<never>
    cloudFeatures: () => ReadonlySet<string> | null
    withConnection: <T>(run: () => Promise<T>) => Promise<T>
    status: () => ConnectorCloudStatus
  }

  function host(options: { cloud?: () => TestCloud | null } = {}) {
    // One cloud for both halves: the route a save takes and the answer `advertised` gives are the same
    // question, so a harness that gave them different clouds would test nothing real.
    const cloud = options.cloud ?? (() => null)
    const localWebhooks = local({ cloud })
    const service = new LocalWebhookHostService({
      userDataPath,
      account: () => 'acct-1',
      cloud,
      automations: {
        list: () => automations,
        runs: () => [],
        setTriggers: () => {},
        remove: () => {}
      },
      botFolder: () => botFolder,
      botFolders: () => [botFolder],
      botExists: () => true,
      newerAgentBotIds: () => new Set<string>(),
      bot: () => undefined,
      notifyOwner: () => {},
      runForEvent: () => Promise.resolve(null),
      local: localWebhooks
    })
    return { service, localWebhooks }
  }

  it('marks the hooks this computer answers, so a signed-out card never calls one paused', async () => {
    const { service, localWebhooks } = host()
    const hookId = await minted(localWebhooks)
    await localWebhooks.start()
    try {
      const hooks = await service.list(BOT)
      expect(hooks.map((hook) => [hook.hookId, hook.servedHere])).toEqual([[hookId, true]])
    } finally {
      localWebhooks.stop()
    }
  })

  it('refuses a Slack rule while signed out, and hears its own webhook rule', () => {
    const { service, localWebhooks } = host({ cloud: signedOutCloud })
    const saves = new AutomationWebhookSaves()
    saves.set(service)
    const bot = makeTestBot({ name: 'Scout' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the refusal reads the rule's source and event only.
    const slack = { id: 'slack-1', source: 'slack', event: 'message' } as AutomationEventTrigger
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a draft webhook rule, as a create sends it.
    const webhook = { id: '', source: 'webhook', event: 'call', rev: 0 } as AutomationEventTrigger
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a hook id nothing here holds.
    const cloudHook = {
      id: 'wh-wh_0000000000000009',
      source: 'webhook',
      event: 'call',
      rev: 1
    } as AutomationEventTrigger

    const hearing = saves.hearing(bot)
    expect(hearing.cloudSignedOut).toBe(true)
    expect(botEventTriggerRefusal(hearing, saves.cloudRules([slack])!)).toContain(
      'signed out of Orca'
    )
    // Its own hook is this computer's, so Orca Cloud is never asked to hear it.
    expect(saves.cloudRules([webhook])).toEqual([])
    expect(botEventTriggerRefusal(hearing, saves.cloudRules([webhook])!)).toBeNull()
    // A hook Orca Cloud made is still the cloud's, and still refused while signed out.
    expect(botEventTriggerRefusal(hearing, saves.cloudRules([cloudHook])!)).toContain(
      'signed out of Orca'
    )
    expect(localWebhooks.servesLocally(webhook)).toBe(true)
    expect(localWebhooks.servesLocally(slack)).toBe(false)
    expect(service.servesLocally(webhook)).toBe(true)
  })

  it('advertises webhooks while signed out, because this computer serves them', () => {
    const { service, localWebhooks } = host({ cloud: signedOutCloud })
    localWebhooks.attach({ onClientEvent: () => {}, onBotsWritten: () => {} })
    return localWebhooks.start().then(() => {
      try {
        expect(service.signedOut()).toBe(true)
        expect(service.advertised()).toBe(true)
      } finally {
        localWebhooks.stop()
      }
    })
  })

  it('says a cloud that does not take webhooks does not, even with its own listener up', async () => {
    const { service, localWebhooks } = host({ cloud: cloudWithoutWebhooks })
    localWebhooks.attach({ onClientEvent: () => {}, onBotsWritten: () => {} })
    await localWebhooks.start()
    try {
      // A signed-in cloud makes the hook, so its answer is the host's: this computer is not a fallback
      // for a cloud that cannot take them, and the save must be refused with the cloud's own message.
      expect(service.advertised()).toBe(false)
      expect(service.localWebhookFacts()).toMatchObject({ answersNew: false })
    } finally {
      localWebhooks.stop()
    }
  })

  it('offers webhooks while signed out, because this computer answers them', async () => {
    const { service, localWebhooks } = host({ cloud: signedOutCloud })
    localWebhooks.attach({ onClientEvent: () => {}, onBotsWritten: () => {} })
    await localWebhooks.start()
    try {
      expect(service.advertised()).toBe(true)
      expect(service.localWebhookFacts()).toMatchObject({ answersNew: true })
    } finally {
      localWebhooks.stop()
    }
  })

  it('tells the CLI the URL changes on restart when the port it wanted was taken', async () => {
    const squatter = createServer()
    const wanted = localWebhookPort(userDataPath)
    await new Promise<void>((resolve, reject) => {
      squatter.once('error', reject)
      squatter.listen(wanted, '127.0.0.1', resolve)
    })
    const { service, localWebhooks } = host()
    try {
      const rule = await service.settle({ automationId: AUTOMATION, botId: BOT, next: draft() })
      automations = [automationFor(rule.on[0]!.id)]
      localWebhooks.attach({ onClientEvent: () => {}, onBotsWritten: () => {} })
      await localWebhooks.start()
      expect(localWebhooks.portIsStable()).toBe(false)
      // The card is what `orca webhooks show` prints, and it has to say the URL will not survive.
      expect(await service.card(hookIdOfRule(rule.on[0]!.id)!)).toMatchObject({
        urlChangesOnRestart: true
      })
    } finally {
      localWebhooks.stop()
      squatter.close()
    }
  })

  it('says nothing about restarts when it holds the port its profile names', async () => {
    const { service, localWebhooks } = host()
    const rule = await service.settle({ automationId: AUTOMATION, botId: BOT, next: draft() })
    automations = [automationFor(rule.on[0]!.id)]
    localWebhooks.attach({ onClientEvent: () => {}, onBotsWritten: () => {} })
    await localWebhooks.start()
    try {
      expect(localWebhooks.portIsStable()).toBe(true)
      expect(await service.card(hookIdOfRule(rule.on[0]!.id)!)).not.toHaveProperty(
        'urlChangesOnRestart'
      )
    } finally {
      localWebhooks.stop()
    }
  })

  it('keeps a local hook out of the cloud ledger', async () => {
    const { service, localWebhooks } = host()
    const rule = await service.settle({ automationId: AUTOMATION, botId: BOT, next: draft() })
    automations = [automationFor(rule.on[0]!.id)]
    const hookId = hookIdOfRule(rule.on[0]!.id)!
    localWebhooks.attach({ onClientEvent: () => {}, onBotsWritten: () => {} })
    await localWebhooks.start()
    try {
      await service.card(hookId)
      expect(webhooksLedgerHooks()).toEqual([])
      expect(service.holdsLocally(hookId)).toBe(true)
      expect(service.servesLocally(rule.on[0]!)).toBe(true)
    } finally {
      localWebhooks.stop()
    }
  })

  it('holds a cloud hook and a local one at once, and routes each to its own host', async () => {
    const { service, localWebhooks } = host()
    const rule = await service.settle({ automationId: AUTOMATION, botId: BOT, next: draft() })
    const localHook = hookIdOfRule(rule.on[0]!.id)!
    automations = [automationFor(rule.on[0]!.id)]
    localWebhooks.attach({ onClientEvent: () => {}, onBotsWritten: () => {} })
    await localWebhooks.start()
    try {
      const remote = new WebhookHostLedger(userDataPath, () => 'acct-1')
      remote.saveHook({
        hookId: 'wh_0000000000000002',
        automationId: 'a2',
        botId: BOT,
        epoch: 1,
        state: 'live'
      })
      expect(service.holdsLocally(localHook)).toBe(true)
      expect(service.holdsLocally('wh_0000000000000002')).toBe(false)

      const response = await deliver(localWebhooks, localHook)
      const { callId } = CallAnswer.parse(await response.json())
      // A call this computer kept is offered here, with its body; one it never saw is the cloud's to answer.
      expect(await localWebhooks.routes.start(callId, 'run-1')).toEqual({
        ok: true,
        value: { started: true }
      })
      const envelope = await localWebhooks.routes.envelope(callId)
      expect(envelope?.ok && envelope.value.body).toEqual({
        kind: 'json',
        value: { action: 'opened' }
      })
      expect(await localWebhooks.routes.start('call_0123456789abcdefABC9', 'run-1')).toBeNull()
    } finally {
      localWebhooks.stop()
    }
  })
})

/** The cloud ledger's hook rows, which a local hook must never reach. */
function webhooksLedgerHooks(): unknown[] {
  try {
    return CloudLedger.parse(
      JSON.parse(readFileSync(join(userDataPath, 'webhook-host.json'), 'utf8'))
    ).hooks
  } catch {
    return []
  }
}

const CloudLedger = z.object({ hooks: z.array(z.unknown()) })
