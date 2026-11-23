// This computer's webhooks beside Orca Cloud's: the listener takes a call, the store keeps it, and the
// same run path offers every call it has not settled again after a restart. A host may hold both kinds
// at once, so a save asks which one it is making first, and an edit keeps whichever it already was.
import { join } from 'node:path'
import {
  automationWebhookTrigger,
  type AutomationRunEvent,
  type AutomationWebhookTrigger
} from '../../../shared/automation-event-triggers'
import type { Automation } from '../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import { hookIdOfRule, WEBHOOK_RUN_CAPS } from '../../../shared/connector-webhook-contract'
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
import { deliveryOf, eventOf } from './local-webhook-delivery'
import {
  settleLocally,
  type LocalWebhookSettleInput,
  type LocalWebhookSettleResult
} from './local-webhook-settle'
import { localHookListed, localWebhookRoutes, localWebhookUrls } from './local-webhook-routes'
import {
  LOCAL_MINT_GRACE_MS,
  LOCAL_WEBHOOK_DIR,
  LocalWebhookStore,
  type LocalHook
} from './local-webhook-store'

/** Local hooks are not the cloud's, so their calls are not either: their own ledger, in their own file. */
export const LOCAL_LEDGER_ACCOUNT = 'local'

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
   * Replay and the bind are independent: offering every unsettled call again is what makes a call kept
   * before its ack survive a restart, so it must not wait on a socket; and a store that cannot be read
   * or written must not stop this computer from listening at all.
   */
  async start(): Promise<void> {
    await Promise.all([
      this.listener.start().catch((error: unknown) => {
        console.warn('[webhooks] this computer’s local webhook listener did not start', error)
      }),
      this.store
        .load()
        .then(() => {
          this.runs.resume()
          return this.changed()
        })
        .then(() => this.sweep.start())
        .catch((error: unknown) => {
          console.warn('[webhooks] could not replay this computer’s webhook calls', error)
        })
    ])
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
      } else if (!(await this.pending(hook, now))) {
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

  /**
   * Whether this computer answers the rule itself, whether or not its hook has been made yet. The
   * ledger is the question's source, not the store: it reads synchronously, so a hello built before the
   * store's index has loaded cannot mistake a local hook for the cloud's and list it.
   */
  servesLocally(rule: { source: string; id?: string }): boolean {
    if (rule.source !== 'webhook') {
      return false
    }
    const hookId = rule.id ? hookIdOfRule(rule.id) : null
    return hookId ? this.holdsLocally(hookId) : !this.cloudMakesHooks()
  }

  holdsLocally(hookId: string): boolean {
    return this.ledger.hook(hookId) !== undefined
  }

  /** This host's hook tokens, for the one route that shows a URL to its owner. */
  async keyOf(hookId: string): Promise<string | undefined> {
    await this.store.load()
    return this.store.hook(hookId)?.token
  }

  /** The call files this computer's ledger owns, so Orca Cloud's sweep leaves them. */
  callFiles(): ReadonlySet<string> {
    return this.ledger.files()
  }

  /**
   * A cloud that makes hooks answers this, so a cloud that does not take webhooks still says so — the
   * save is refused with "Orca Cloud doesn't support webhooks yet" instead of failing inside the mint,
   * and `bots.list` does not offer webhook.call to a bot that cannot have it. Only a host with no cloud
   * to make one falls back to this computer's listener.
   */
  advertised(fromHost: () => boolean): boolean {
    return this.cloudMakesHooks() ? fromHost() : this.answersNewWebhooks()
  }

  /** Whether a webhook rule made now would be answered here; what a hello and the CLI need to know. */
  answersNewWebhooks(): boolean {
    return !this.cloudMakesHooks()
  }

  /** Whether the listener holds the port this profile names, so a URL survives a restart. */
  portIsStable(): boolean {
    return this.listener.stable()
  }

  /** The hook ids this computer holds, for the CLI to ask per rule; synchronous, so a hello can too. */
  heldLocally(): string[] {
    return this.ledger.hooks().map((hook) => hook.hookId)
  }

  async settle(
    input: LocalWebhookSettleInput,
    fromHost: (input: LocalWebhookSettleInput) => Promise<LocalWebhookSettleResult>
  ): Promise<LocalWebhookSettleResult> {
    await this.store.load()
    const kept = hookOfRule(input.current ? automationWebhookTrigger(input.current) : undefined)
    const here = kept ? this.holdsLocally(kept) : !this.cloudMakesHooks()
    return here
      ? settleLocally({ store: this.store, ledger: this.ledger, now: this.now }, input)
      : fromHost(input)
  }

  /** A hook minted for an automation whose save has not landed; the cloud's intents have the same grace. */
  private async pending(hook: LocalHook, now: number): Promise<boolean> {
    const intent = this.store.intents().find((entry) => entry.hookId === hook.hookId)
    if (!intent) {
      return false
    }
    if (now - intent.createdAt > LOCAL_MINT_GRACE_MS) {
      await this.store.dropIntent(hook.hookId)
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
      const kept = await this.store.putCall(
        { callId: call.callId, hookId: call.hookId, createdAt: call.envelope.receivedAt },
        call.envelope
      )
      if (!kept) {
        // Its hook went while the body was being written: nothing is left to answer for this call.
        return 'failed'
      }
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
