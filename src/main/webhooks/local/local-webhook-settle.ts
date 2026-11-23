// A webhook save that this computer answers: the rule's id, and the hook it names. Minted here rather
// than in Orca Cloud, so there is no operation id and nothing remote to confirm.
import { randomBytes } from 'node:crypto'
import {
  automationWebhookTrigger,
  isWebhookTrigger,
  type AutomationEventTrigger
} from '../../../shared/automation-event-triggers'
import type { Automation } from '../../../shared/automations/automation-definition'
import { webhookRuleId } from '../../../shared/connector-webhook-contract'
import type { WebhookHostLedger } from '../webhook-host-ledger'
import { filtersOf } from './local-webhook-delivery'
import { LOCAL_WEBHOOK_EPOCH, type LocalHook, type LocalWebhookStore } from './local-webhook-store'

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

export type LocalSettleDeps = {
  store: LocalWebhookStore
  ledger: WebhookHostLedger
  now: () => number
}

/** The rule a save names, with the hook it was made as; no operation id, because nothing remote confirms it. */
export async function settleLocally(
  deps: LocalSettleDeps,
  input: LocalWebhookSettleInput
): Promise<LocalWebhookSettleResult> {
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
  const minted = deps.store
    .intents()
    .find((intent) => intent.automationId === input.automationId)?.hookId
  const hook = (minted ? deps.store.hook(minted) : undefined) ?? (await mintHook(deps, input))
  return { on: [...others, { ...wanted, id: webhookRuleId(hook.hookId), rev: 1 }] }
}

/** The hook a save names, and the ledger row that lets its first real call say so. */
export async function mintHook(
  deps: Pick<LocalSettleDeps, 'store' | 'ledger' | 'now'>,
  input: { automationId: string; botId: string }
): Promise<LocalHook> {
  const hook: LocalHook = {
    hookId: `wh_${randomBytes(8).toString('hex')}`,
    token: randomBytes(32).toString('base64url'),
    automationId: input.automationId,
    botId: input.botId,
    epoch: LOCAL_WEBHOOK_EPOCH,
    created: deps.now()
  }
  await deps.store.putHook(hook)
  await deps.store.saveIntent({
    automationId: input.automationId,
    hookId: hook.hookId,
    createdAt: hook.created
  })
  deps.ledger.saveHook({
    hookId: hook.hookId,
    automationId: hook.automationId,
    botId: hook.botId,
    epoch: hook.epoch,
    state: 'live'
  })
  return hook
}
