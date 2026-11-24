// The host the install creates: Orca Cloud's answers stay its own, a webhook save is routed to this
// computer when the cloud cannot make the hook, and a hook this computer holds never reaches the cloud.
import type { AutomationEventTrigger } from '../../../shared/automation-event-triggers'
import type { WebhookKey, WebhookSummary } from '../../../shared/rpc-contract/webhooks-params'
import { webhookSummary } from '../webhook-cloud-routes'
import { WebhookHostService, type WebhookHostServiceDeps } from '../webhook-host-service'
import type { LocalWebhooks } from './local-webhook-provider'
import type { LocalWebhookSettleInput, LocalWebhookSettleResult } from './local-webhook-settle'

export type LocalWebhookHostDeps = WebhookHostServiceDeps & { local: LocalWebhooks }

/** What this host answers itself, for a hello and for `bots.list`. */
export type LocalWebhookFacts = { answersNew: boolean; held: readonly string[] }

/**
 * The facts, from whatever `runtime.getWebhooks()` returned. Only this build's host has them, so the
 * question is asked structurally: anything else answers nothing, which is the same as no cloud.
 */
export function localWebhookFactsOf(host: unknown): LocalWebhookFacts {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method is checked for before it is called, and nothing else is read.
  const facts = (host as { localWebhookFacts?: () => LocalWebhookFacts } | null)?.localWebhookFacts
  return typeof facts === 'function' ? facts.call(host) : { answersNew: false, held: [] }
}

export class LocalWebhookHostService extends WebhookHostService {
  private readonly local: LocalWebhooks

  constructor({ local, routes, ...deps }: LocalWebhookHostDeps) {
    // A local hook's answers come from this computer unless the caller wired its own routes.
    super({ ...deps, routes: routes ?? local.routes })
    this.local = local
  }

  override advertised(): boolean {
    return this.local.advertised(() => super.advertised())
  }

  /** Whether a webhook rule made now would be answered here, and the hook ids this computer holds. */
  localWebhookFacts(): LocalWebhookFacts {
    return { answersNew: this.local.answersNewWebhooks(), held: this.local.heldLocally() }
  }

  /** Whether this computer answers the rule itself, so Orca Cloud is never asked to. */
  servesLocally(rule: AutomationEventTrigger): boolean {
    return this.local.servesLocally(rule)
  }

  /** Whether this computer holds the hook, by the id a hello or a card names. */
  holdsLocally(hookId: string): boolean {
    return this.local.holdsLocally(hookId)
  }

  /** Every hook says whether this computer answers it, so a signed-out card does not call a working one paused. */
  override async list(botId: string): Promise<WebhookSummary[]> {
    const hooks = await super.list(botId)
    return hooks.map((hook) =>
      this.local.holdsLocally(hook.hookId) ? { ...hook, servedHere: true } : hook
    )
  }

  /** A local hook's card is this computer's, and reading it must not write a row into Orca Cloud's ledger. */
  override async card(hookId: string): Promise<WebhookSummary> {
    if (!this.local.holdsLocally(hookId)) {
      return super.card(hookId)
    }
    const hook = await this.local.routes.get(hookId)
    if (!hook?.ok) {
      throw new Error('webhooks_unavailable')
    }
    const summary = webhookSummary(hook.value, this.automationOf(hookId))
    const here = { ...summary, servedHere: true as const }
    // Its port was taken, so the URL a forwarder was given stops working at the next restart.
    return this.local.portIsStable() ? here : { ...here, urlChangesOnRestart: true }
  }

  override settle(input: LocalWebhookSettleInput): Promise<LocalWebhookSettleResult> {
    return this.local.settle(input, (value) => super.settle(value))
  }

  /** A local hook's URL carries its token, which is the whole of its auth; a cloud hook's is revealed. */
  override async reveal(hookId: string): Promise<WebhookKey> {
    const key = await this.local.keyOf(hookId)
    if (key === undefined) {
      return super.reveal(hookId)
    }
    const { url } = await this.card(hookId)
    return { key, url }
  }
}
