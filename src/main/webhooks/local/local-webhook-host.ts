// The host the install creates: Orca Cloud's answers stay its own, a webhook save is routed to this
// computer when the cloud cannot make the hook, and a hook this computer holds never reaches the cloud.
import type { AutomationEventTrigger } from '../../../shared/automation-event-triggers'
import type { WebhookKey, WebhookSummary } from '../../../shared/rpc-contract/webhooks-params'
import { webhookSummary } from '../webhook-cloud-routes'
import { WebhookHostService, type WebhookHostServiceDeps } from '../webhook-host-service'
import type {
  LocalWebhooks,
  LocalWebhookSettleInput,
  LocalWebhookSettleResult
} from './local-webhook-provider'

export type LocalWebhookHostDeps = WebhookHostServiceDeps & { local: LocalWebhooks }

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

  /** Whether this computer answers the rule itself, so Orca Cloud is never asked to. */
  servesLocally(rule: AutomationEventTrigger): boolean {
    return this.local.servesLocally(rule)
  }

  /** Whether this computer holds the hook, by the id a hello or a card names. */
  holdsLocally(hookId: string): boolean {
    return this.local.holdsLocally(hookId)
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
    return webhookSummary(hook.value, this.automationOf(hookId))
  }

  override settle(input: LocalWebhookSettleInput): Promise<LocalWebhookSettleResult> {
    return this.local.settle(input, (value) => super.settle(value))
  }

  /** A local hook's URL carries its token, which is the whole of its auth; a cloud hook's is revealed. */
  override async reveal(hookId: string): Promise<WebhookKey> {
    const key = this.local.keyOf(hookId)
    if (key === undefined) {
      return super.reveal(hookId)
    }
    const { url } = await this.card(hookId)
    return { key, url }
  }
}
