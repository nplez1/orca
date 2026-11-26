// The install hunk: a host with no Orca Cloud still installs webhooks, because this computer serves
// them itself. R1 wired the service inside the connector-cloud guard, which left it null here.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as z from 'zod'
import { EVENT_ONLY_SCHEDULE } from '../../shared/automation-event-triggers'
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationEventTrigger } from '../../shared/automation-event-triggers'
import type { RuntimeClientEvent } from '../../shared/remote-runtime/session-graph/runtime-client-events'
import { makeTestBot } from '../bots/bot.test-fixture'
import type { Store } from '../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { installConnectorHost, type ConnectorHost } from './connector-host-install'

vi.mock('./connector-cloud-install', () => ({ createConnectorCloud: () => null }))
vi.mock('../bots/bot-access-request-watch', () => ({
  botAccessSeenFile: () => '',
  createBotAccessRequestWatch: () => ({ start: () => () => {} })
}))
vi.mock('../bots/bot-access-host', () => ({ botAccessHost: () => ({}) }))
vi.mock('./bot-avatar-sync', () => ({
  BotAvatarSync: class {
    changed = () => {}
  }
}))
vi.mock('../linear/accounts/linear-login-refresh', () => ({
  refreshDueLinearLogins: async () => {}
}))
vi.mock('./connector-token-mint', () => ({ connectorAccount: () => null }))

const ENDPOINT = process.platform === 'win32' ? 'endpoint.cmd' : 'endpoint.env'
const Answer = z.object({ ok: z.literal(true), callId: z.string() })
const StateAnswer = z.object({ hooks: z.array(z.object({ hookId: z.string(), url: z.string() })) })

let userDataPath: string
let host: ConnectorHost
type ListedAutomation = Pick<
  Automation,
  'id' | 'name' | 'enabled' | 'bot' | 'on' | 'dtstart' | 'rrule'
>

/** The rule the save just made, as the installation's own store would list it. */
const listed = (on: AutomationEventTrigger[]): ListedAutomation => ({
  id: 'a1',
  name: 'Review my PRs',
  enabled: true,
  bot: { botId: 'wh-bot', runsIn: 'new', resultsTo: 'chat' },
  on,
  ...EVENT_ONLY_SCHEDULE
})

type HostService = {
  settle: (input: {
    automationId: string
    botId: string
    next: AutomationEventTrigger[]
  }) => Promise<{ on: AutomationEventTrigger[] }>
}
let service: HostService | null
let automations: ListedAutomation[]

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-local-webhooks-install-'))
  automations = []
  service = null
  const bot = makeTestBot({})
  const listeners: ((event: RuntimeClientEvent) => void)[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the installer reads only these runtime members, and the host work it starts is mocked above.
  const runtime = {
    setConnectorCloud: () => {},
    getConnectorCloud: () => null,
    setWebhooks: (webhooks: HostService) => {
      service = webhooks
    },
    onClientEvent: (listener: (event: RuntimeClientEvent) => void) => listeners.push(listener),
    onBotsWritten: () => () => {},
    // The installer subscribes to stored Slack icons (upstream's `BotController.slackIcons`), so the
    // fake carries the subscription it now needs, not just `enabled`.
    bots: { enabled: () => true, slackIcons: { onStored: () => () => {} } },
    botWork: {},
    readMachineName: () => 'Studio Mac',
    machineNameReady: async () => {},
    getExternalConversationSeam: () => undefined,
    notifyBotsChanged: () => {},
    runAutomationForEvent: async () => null,
    updateAutomation: async () => undefined,
    deleteAutomation: async () => undefined
  } as unknown as OrcaRuntimeService
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the installer reads bots, automations and settings only.
  const store = {
    getBots: () => [bot],
    getFolderWorkspaces: () => [],
    listAutomations: () => automations,
    listAutomationRuns: () => [],
    getSettings: () => ({ botsEnabled: true }),
    onSettingsChanged: () => () => {}
  } as unknown as Store
  host = installConnectorHost({
    runtime,
    store,
    userDataPath,
    kind: 'desktop',
    isFenced: () => false
  })
})

afterEach(() => {
  host.stop()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('a host without Orca Cloud', () => {
  it('installs webhooks anyway, and publishes where this computer listens', async () => {
    expect(service).not.toBeNull()
    // The listener is started by attach(), so the endpoint file appears once its port is bound.
    await vi.waitFor(() =>
      expect(readFileSync(join(userDataPath, 'local-webhooks', ENDPOINT), 'utf8')).toContain(
        'ORCA_LOCAL_WEBHOOK_PORT='
      )
    )
    // Its own hook is made here, with no cloud to ask.
    const settled = await service!.settle({
      automationId: 'a1',
      botId: 'wh-bot',
      next: [{ id: '', source: 'webhook', event: 'call', rev: 0 }]
    })
    expect(settled.on[0]).toMatchObject({ source: 'webhook', rev: 1 })
    // The installation reads only these fields of an automation, so the store hands it this much.
    automations = [listed(settled.on)]

    const endpoint = readFileSync(join(userDataPath, 'local-webhooks', ENDPOINT), 'utf8')
    const port = /ORCA_LOCAL_WEBHOOK_PORT=(\d+)/.exec(endpoint)![1]
    const token = /ORCA_LOCAL_WEBHOOK_TOKEN=(\S+)/.exec(endpoint)![1]
    const state = await fetch(`http://127.0.0.1:${port}/state`, {
      headers: { authorization: `Bearer ${token}` }
    })
    const { hooks } = StateAnswer.parse(await state.json())
    const answer = await fetch(hooks[0]!.url, {
      method: 'POST',
      body: '{"action":"opened"}',
      headers: { 'content-type': 'application/json' }
    })
    expect(answer.status).toBe(200)
    expect(Answer.parse(await answer.json()).callId).toMatch(/^call_/)
  })
})
