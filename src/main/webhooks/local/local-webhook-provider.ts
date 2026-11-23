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
import {
  hookIdOfRule,
  WEBHOOK_RUN_CAPS,
  webhookRuleId
} from '../../../shared/connector-webhook-contract'
import type { EventStartGate } from '../../automations/automation-trigger-runs'
import { WebhookCallRuns } from '../webhook-call-runs'
import { webhookCloudCalls, type WebhookCloudCalls } from '../webhook-cloud-routes'
import { WebhookHostLedger } from '../webhook-host-ledger'
import type { WebhookHostServiceDeps } from '../webhook-host-service'
import { WebhookRecoverySweep } from '../webhook-recovery-sweep'
import {
  LOCAL_WEBHOOK_HOUR_MS,
  LocalWebhookListener,
  type LocalWebhookCall,
  type LocalWebhookVerdict
} from './local-webhook-listener'
import { deliveryOf, filtersOf, eventOf } from './local-webhook-delivery'
import { localHookListed, localWebhookRoutes, localWebhookUrls } from './local-webhook-routes'
import {
  LOCAL_MINT_GRACE_MS,
  LOCAL_WEBHOOK_DIR,
  LOCAL_WEBHOOK_EPOCH,
  LocalWebhookStore,
  type LocalHook
} from './local-webhook-store'

/** Local hooks are not the cloud's, so their calls are not either: their own ledger, in their own file. */
export const LOCAL_LEDGER_ACCOUNT = 'local'

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
  /** Calls past the cap check but not yet in the ledger, per hook; the check and this move together. */
  private readonly admitting = new Map<string, number>()

  constructor(private readonly deps: LocalWebhooksDeps) {
    this.now = deps.now ?? Date.now
    this.store = new LocalWebhookStore(deps.userDataPath)
    this.ledger = new WebhookHostLedger(join(deps.userDataPath, LOCAL_WEBHOOK_DIR), () => {
      return LOCAL_LEDGER_ACCOUNT
    })
    this.cloudRoutes = webhookCloudCalls(deps.cloud)
    this.store.load().catch((error: unknown) => {
      console.warn('[webhooks] could not read this computer’s local webhooks', error)
    })
    this.routes = localWebhookRoutes({
      cloud: this.cloudRoutes,
      store: this.store,
      ledger: this.ledger,
      automations: deps.automations.list,
      listener: () => this.listener
    })
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
      taken: (hookId, since) => this.taken(hookId, since),
      deliver: (call) => this.deliver(call),
      urls: () => localWebhookUrls({ store: this.store, listener: () => this.listener }),
      now: deps.now
    })
  }

  /**
   * Replay comes first and does not wait on the socket: offering every unsettled call again is what
   * makes a call kept before its ack survive a restart, and a port that will not bind must not hide it.
   */
  async start(): Promise<void> {
    await this.store.load()
    this.runs.resume()
    await this.changed()
    void this.sweep.start()
    await this.listener.start().catch((error: unknown) => {
      console.warn('[webhooks] this computer’s local webhook listener did not start', error)
    })
  }

  stop(): void {
    this.runs.stop()
    this.sweep.stop()
    this.listener.stop()
  }

  /** An automation, a bot or a hook changed: drop what nothing lists any more, then let the sweep follow. */
  async changed(): Promise<void> {
    await this.store.load()
    const now = this.now()
    for (const hook of this.store.hooks()) {
      if (localHookListed(this.deps.automations.list, hook)) {
        await this.store.dropIntent(hook.hookId)
      } else if (!this.pending(hook, now)) {
        // Not listed and not waiting on a save: nothing will ever name it.
        await this.dropHook(hook.hookId)
      }
    }
    await this.store.prune(() => true, new Set(this.ledger.calls().map((call) => call.callId)))
    this.sweep.arm()
  }

  /** Follows what can change which hooks exist: an automation, a bot or a repository edit. */
  attach(events: {
    onClientEvent: (listener: (event: { type: string }) => void) => void
    onBotsWritten: (listener: () => void) => void
  }): void {
    const changed = (): void => {
      this.changed().catch((error: unknown) =>
        console.warn('[webhooks] could not bring this computer’s webhooks up to date', error)
      )
    }
    events.onClientEvent((event) => {
      if (event.type === 'automationsChanged' || event.type === 'reposChanged') {
        changed()
      }
    })
    events.onBotsWritten(changed)
    void this.start()
  }

  /** The routes a `WebhookHostService` asks, answered here for a local hook and by the cloud otherwise. */
  readonly routes: WebhookCloudCalls

  /** Whether a new webhook goes here rather than to Orca Cloud: no account, or signed out of it. */
  private cloudMakesHooks(): boolean {
    const cloud = this.deps.cloud()
    return cloud !== null && cloud.status?.() !== 'signed-out'
  }

  /** Whether this computer answers the rule itself, whether or not its hook has been made yet. */
  servesLocally(rule: { source: string; id?: string }): boolean {
    if (rule.source !== 'webhook') {
      return false
    }
    const hookId = rule.id ? hookIdOfRule(rule.id) : null
    return hookId ? this.store.hook(hookId) !== undefined : !this.cloudMakesHooks()
  }

  holdsLocally(hookId: string): boolean {
    return this.store.hook(hookId) !== undefined
  }

  /** This host's hook tokens, for the one route that shows a URL to its owner. */
  keyOf(hookId: string): string | undefined {
    return this.store.hook(hookId)?.token
  }

  /** The call files this computer's ledger owns, so Orca Cloud's sweep leaves them. */
  callFiles(): ReadonlySet<string> {
    return this.ledger.files()
  }

  advertised(fromHost: () => boolean): boolean {
    return this.listener.listening() || fromHost()
  }

  async settle(
    input: LocalWebhookSettleInput,
    fromHost: (input: LocalWebhookSettleInput) => Promise<LocalWebhookSettleResult>
  ): Promise<LocalWebhookSettleResult> {
    await this.store.load()
    const kept = hookOfRule(input.current ? automationWebhookTrigger(input.current) : undefined)
    const here = kept ? this.holdsLocally(kept) : !this.cloudMakesHooks()
    return here ? this.settleLocally(input) : fromHost(input)
  }

  /** Mints the hook and the rule that names it; no operation id, because there is nothing remote to confirm. */
  private async settleLocally(input: LocalWebhookSettleInput): Promise<LocalWebhookSettleResult> {
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
    // Only a mint that has not been saved yet is reused: a token nothing lists is not this save's.
    const minted = this.store
      .intents()
      .find((intent) => intent.automationId === input.automationId)?.hookId
    const hook = (minted ? this.store.hook(minted) : undefined) ?? (await this.mint(input))
    return { on: [...others, { ...wanted, id: webhookRuleId(hook.hookId), rev: 1 }] }
  }

  private async mint(input: LocalWebhookSettleInput): Promise<LocalHook> {
    const hook: LocalHook = {
      hookId: `wh_${randomBytes(8).toString('hex')}`,
      token: randomBytes(32).toString('base64url'),
      automationId: input.automationId,
      botId: input.botId,
      epoch: LOCAL_WEBHOOK_EPOCH,
      created: this.now()
    }
    await this.store.putHook(hook)
    await this.store.saveIntent({
      automationId: input.automationId,
      hookId: hook.hookId,
      createdAt: hook.created
    })
    // The ledger's hook row is what lets its first real call say so, and what a pause would name.
    this.ledger.saveHook({
      hookId: hook.hookId,
      automationId: hook.automationId,
      botId: hook.botId,
      epoch: hook.epoch,
      state: 'live'
    })
    return hook
  }

  /** A hook minted for an automation whose save has not landed; the cloud's intents have the same grace. */
  private pending(hook: LocalHook, now: number): boolean {
    const intent = this.store.intents().find((entry) => entry.hookId === hook.hookId)
    if (!intent) {
      return false
    }
    if (now - intent.createdAt > LOCAL_MINT_GRACE_MS) {
      this.store.dropIntent(hook.hookId)
      return false
    }
    return true
  }

  private taken(hookId: string, since: number): number {
    const kept = this.ledger
      .calls()
      .filter((call) => call.hookId === hookId && call.occurredAt >= since).length
    return kept + (this.admitting.get(hookId) ?? 0)
  }

  private admit(hookId: string, change: 1 | -1): void {
    const next = (this.admitting.get(hookId) ?? 0) + change
    if (next > 0) {
      this.admitting.set(hookId, next)
    } else {
      this.admitting.delete(hookId)
    }
  }

  private async deliver(call: LocalWebhookCall): Promise<LocalWebhookVerdict> {
    const hook = this.store.hook(call.hookId)
    if (!hook) {
      return 'failed'
    }
    // Asked again here, and reserved in the same breath: reading the body was awaited, so senders that
    // arrived together all passed the listener's check, and only a synchronous check-then-count holds.
    const since = call.envelope.receivedAt - LOCAL_WEBHOOK_HOUR_MS
    if (this.taken(call.hookId, since) >= WEBHOOK_RUN_CAPS.hookDefault) {
      return 'over_cap'
    }
    this.admit(call.hookId, 1)
    try {
      await this.store.putCall(
        { callId: call.callId, hookId: call.hookId, createdAt: call.envelope.receivedAt },
        call.envelope
      )
      if (!this.runs.receive(deliveryOf(hook, call), eventOf(hook, call))) {
        await this.store.dropCall(call.callId)
        return 'failed'
      }
      this.sweep.arm()
      return 'kept'
    } catch (error) {
      console.warn('[webhooks] could not keep a local call', error)
      return 'failed'
    } finally {
      this.admit(call.hookId, -1)
    }
  }

  private async dropHook(hookId: string): Promise<void> {
    await this.store.dropHook(hookId)
    this.ledger.dropHook(hookId)
  }
}
