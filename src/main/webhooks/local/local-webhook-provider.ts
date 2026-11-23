// This computer's webhooks beside Orca Cloud's: the listener takes a call, the store keeps it, and the
// same run path offers every call it has not settled again after a restart. A host may hold both kinds
// at once, so a save asks which one it is making first, and an edit keeps whichever it already was.
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import {
  automationWebhookTrigger,
  isWebhookTrigger,
  type AutomationEventTrigger,
  type AutomationRunEvent,
  type AutomationWebhookTrigger
} from '../../../shared/automation-event-triggers'
import type { Automation } from '../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import type { ConnectorDelivery } from '../../../shared/connectors/connector-cloud-contract'
import {
  hookIdOfRule,
  webhookActorId,
  webhookRuleId,
  type WebhookFilters
} from '../../../shared/connector-webhook-contract'
import type { EventStartGate } from '../../automations/automation-trigger-runs'
import { WebhookCallRuns } from '../webhook-call-runs'
import { webhookCloudCalls, type WebhookCloudCalls } from '../webhook-cloud-routes'
import { WEBHOOK_LEDGER_RETENTION_MS, WebhookHostLedger } from '../webhook-host-ledger'
import { WebhookHostService, type WebhookHostServiceDeps } from '../webhook-host-service'
import { WebhookRecoverySweep } from '../webhook-recovery-sweep'
import { LocalWebhookListener, type LocalWebhookCall } from './local-webhook-listener'
import { localHookListed, localWebhookRoutes, localWebhookUrls } from './local-webhook-routes'
import {
  LOCAL_WEBHOOK_DIR,
  LOCAL_WEBHOOK_EPOCH,
  LocalWebhookStore,
  type LocalHook
} from './local-webhook-store'

/** Local hooks are not the cloud's, so their calls are not either: their own ledger, in their own file. */
const LOCAL_LEDGER_ACCOUNT = 'local'

type TriggerDelivery = Extract<ConnectorDelivery, { kind: 'trigger' }>

export type LocalWebhookSettleInput = {
  automationId: string
  botId: string
  current?: Automation
  next: readonly AutomationEventTrigger[]
}
export type LocalWebhookSettleResult = {
  on: AutomationEventTrigger[]
  operationId?: string
}

export type LocalWebhooksDeps = {
  userDataPath: string
  cloud: WebhookHostServiceDeps['cloud']
  automations: {
    list: () => readonly Automation[]
    runs: (automationId: string) => readonly AutomationRun[]
  }
  botFolder: (botId: string) => string | null
  runForEvent: (
    automationId: string,
    event: AutomationRunEvent,
    gate: EventStartGate
  ) => Promise<AutomationRun | null>
  now?: () => number
}

const filtersOf = ({ where, textContains, pick, subjectFrom, subject }: WebhookFilters): string =>
  JSON.stringify([where ?? [], textContains ?? '', pick ?? [], subjectFrom ?? '', subject ?? ''])

function hookOfRule(rule: AutomationWebhookTrigger | undefined): string | null {
  return rule ? hookIdOfRule(rule.id) : null
}

export class LocalWebhooks {
  private readonly store: LocalWebhookStore
  private readonly ledger: WebhookHostLedger
  private readonly cloudRoutes: WebhookCloudCalls
  private readonly runs: WebhookCallRuns
  private readonly sweep: WebhookRecoverySweep
  private readonly listener: LocalWebhookListener
  private readonly now: () => number

  constructor(private readonly deps: LocalWebhooksDeps) {
    this.now = deps.now ?? Date.now
    this.store = new LocalWebhookStore(deps.userDataPath)
    this.ledger = new WebhookHostLedger(join(deps.userDataPath, LOCAL_WEBHOOK_DIR), () => {
      return LOCAL_LEDGER_ACCOUNT
    })
    this.cloudRoutes = webhookCloudCalls(deps.cloud)
    this.runs = new WebhookCallRuns({
      ledger: this.ledger,
      cloud: this.routes,
      automations: deps.automations.list,
      runs: deps.automations.runs,
      botFolder: deps.botFolder,
      runForEvent: deps.runForEvent
    })
    this.sweep = new WebhookRecoverySweep({
      ledger: this.ledger,
      settleRuns: () => this.runs.sweep(),
      reconcileHooks: () => {},
      botFolders: () => []
    })
    this.listener = new LocalWebhookListener({
      userDataPath: deps.userDataPath,
      hook: (hookId) => this.store.hook(hookId),
      taken: (hookId, since) =>
        this.ledger.calls().filter((call) => call.hookId === hookId && call.occurredAt >= since)
          .length,
      deliver: (call) => this.deliver(call),
      urls: () => localWebhookUrls({ store: this.store, listener: () => this.listener }),
      now: deps.now
    })
  }

  async start(): Promise<void> {
    await this.listener.start()
    this.runs.resume()
    this.changed()
    await this.sweep.start()
  }

  stop(): void {
    this.runs.stop()
    this.sweep.stop()
    this.listener.stop()
  }

  /** An automation, a bot or a hook changed: drop what nothing lists any more, then let the sweep follow. */
  changed(): void {
    for (const hook of this.store.hooks()) {
      if (!localHookListed(this.deps.automations.list, hook)) {
        this.dropHook(hook.hookId)
      }
    }
    this.store.prune(() => true, new Set(this.ledger.calls().map((call) => call.callId)))
    this.sweep.arm()
  }

  /** Follows what can change which hooks exist: an automation, a bot or a repository edit. */
  attach(events: {
    onClientEvent: (listener: (event: { type: string }) => void) => void
    onBotsWritten: (listener: () => void) => void
  }): void {
    events.onClientEvent((event) => {
      if (event.type === 'automationsChanged' || event.type === 'reposChanged') {
        this.changed()
      }
    })
    events.onBotsWritten(() => this.changed())
    this.start().catch((error: unknown) => {
      console.warn('[webhooks] this computer’s local webhook listener did not start', error)
    })
  }

  /** The routes a `WebhookHostService` asks, answered here for a local hook and by the cloud otherwise. */
  get routes(): WebhookCloudCalls {
    return localWebhookRoutes({
      cloud: this.cloudRoutes,
      store: this.store,
      ledger: this.ledger,
      automations: this.deps.automations.list,
      listener: () => this.listener
    })
  }

  /** Whether a new webhook goes here rather than to Orca Cloud: no account, or signed out of it. */
  private cloudMakesHooks(): boolean {
    const cloud = this.deps.cloud()
    return cloud !== null && cloud.status?.() !== 'signed-out'
  }

  advertised(fromHost: () => boolean): boolean {
    return this.deps.cloud() ? fromHost() : this.listener.listening()
  }

  /** A local hook outlives sign-out, so this host is not signed out of the route its hooks use. */
  signedOut(fromHost: () => boolean): boolean {
    return this.listener.listening() ? false : fromHost()
  }

  settle(
    input: LocalWebhookSettleInput,
    fromHost: (input: LocalWebhookSettleInput) => Promise<LocalWebhookSettleResult>
  ): Promise<LocalWebhookSettleResult> {
    const kept = hookOfRule(input.current ? automationWebhookTrigger(input.current) : undefined)
    const here = kept ? this.store.hook(kept) !== undefined : !this.cloudMakesHooks()
    return here ? Promise.resolve(this.settleLocally(input)) : fromHost(input)
  }

  /** Mints the hook and the rule that names it; no operation id, because there is nothing remote to confirm. */
  private settleLocally(input: LocalWebhookSettleInput): LocalWebhookSettleResult {
    const wanted = input.next.find(isWebhookTrigger)
    if (!wanted) {
      return { on: [...input.next] }
    }
    const kept = input.current ? automationWebhookTrigger(input.current) : undefined
    if (wanted.id && wanted.id !== kept?.id) {
      throw new Error(
        "A webhook's id comes from the hook it was made as; leave it out to make a new one."
      )
    }
    const others = input.next.filter((trigger) => trigger !== wanted)
    if (kept) {
      const rev = filtersOf(wanted) === filtersOf(kept) ? kept.rev : kept.rev + 1
      return { on: [...others, { ...wanted, id: kept.id, rev }] }
    }
    const hook =
      this.store.hooks().find((entry) => entry.automationId === input.automationId) ??
      this.mint(input.automationId, input.botId)
    return { on: [...others, { ...wanted, id: webhookRuleId(hook.hookId), rev: 1 }] }
  }

  private mint(automationId: string, botId: string): LocalHook {
    const hook: LocalHook = {
      hookId: `wh_${randomBytes(8).toString('hex')}`,
      token: randomBytes(32).toString('base64url'),
      automationId,
      botId,
      epoch: LOCAL_WEBHOOK_EPOCH,
      created: this.now()
    }
    this.store.putHook(hook)
    // The ledger's hook row is what lets its first real call say so, and what a pause would name.
    this.ledger.saveHook({
      hookId: hook.hookId,
      automationId,
      botId,
      epoch: hook.epoch,
      state: 'live'
    })
    return hook
  }

  private deliver(call: LocalWebhookCall): boolean {
    const hook = this.store.hook(call.hookId)
    if (!hook) {
      return false
    }
    try {
      this.store.putCall({ callId: call.callId, hookId: call.hookId, envelope: call.envelope })
      if (!this.runs.receive(deliveryOf(hook, call), eventOf(hook, call))) {
        this.store.dropCall(call.callId)
        return false
      }
      this.sweep.arm()
      return true
    } catch (error) {
      console.warn('[webhooks] could not keep a local call', error)
      return false
    }
  }

  private dropHook(hookId: string): void {
    this.store.dropHook(hookId)
    for (const call of this.ledger.calls().filter((entry) => entry.hookId === hookId)) {
      this.ledger.forget(call.callId)
    }
  }
}

/** The host a local route needs: the cloud's answers stay its own, and only a webhook save is routed. */
export type LocalWebhookHostDeps = WebhookHostServiceDeps & { local: LocalWebhooks }

export class LocalWebhookHostService extends WebhookHostService {
  private readonly local: LocalWebhooks

  constructor({ local, ...deps }: LocalWebhookHostDeps) {
    super(deps)
    this.local = local
  }

  override advertised(): boolean {
    return this.local.advertised(() => super.advertised())
  }

  override signedOut(): boolean {
    return this.local.signedOut(() => super.signedOut())
  }

  override settle(input: LocalWebhookSettleInput): Promise<LocalWebhookSettleResult> {
    return this.local.settle(input, (value) => super.settle(value))
  }
}

function deliveryOf(hook: LocalHook, call: LocalWebhookCall): TriggerDelivery {
  return {
    kind: 'trigger',
    deliveryId: call.callId,
    expiresAt: call.envelope.receivedAt + WEBHOOK_LEDGER_RETENTION_MS,
    conversation: { source: 'webhook', externalId: hook.hookId },
    automationId: hook.automationId,
    triggerId: webhookRuleId(hook.hookId),
    botId: hook.botId,
    event: {
      key: call.callId,
      actorId: webhookActorId(hook.hookId),
      occurredAt: call.envelope.receivedAt,
      webhook: { callId: call.callId, epoch: hook.epoch }
    }
  }
}

function eventOf(hook: LocalHook, call: LocalWebhookCall): AutomationRunEvent {
  return {
    triggerId: webhookRuleId(hook.hookId),
    source: 'webhook',
    event: 'call',
    key: call.callId,
    occurredAt: call.envelope.receivedAt
  }
}
