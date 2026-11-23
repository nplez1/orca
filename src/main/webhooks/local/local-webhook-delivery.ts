// A local call as the run path takes it: the trigger delivery Orca Cloud would have sent, the event a
// run quotes, and the rule comparison an edit uses. Nothing here is Orca Cloud's code.
import type { AutomationRunEvent } from '../../../shared/automation-event-triggers'
import type { ConnectorDelivery } from '../../../shared/connectors/connector-cloud-contract'
import {
  webhookActorId,
  webhookRuleId,
  type WebhookFilters
} from '../../../shared/connector-webhook-contract'
import { WEBHOOK_LEDGER_RETENTION_MS } from '../webhook-host-ledger'
import type { LocalWebhookCall } from './local-webhook-listener'
import type { LocalHook } from './local-webhook-store'

type TriggerDelivery = Extract<ConnectorDelivery, { kind: 'trigger' }>

export const filtersOf = ({
  where,
  textContains,
  pick,
  subjectFrom,
  subject
}: WebhookFilters): string =>
  JSON.stringify([where ?? [], textContains ?? '', pick ?? [], subjectFrom ?? '', subject ?? ''])

export function deliveryOf(hook: LocalHook, call: LocalWebhookCall): TriggerDelivery {
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

export function eventOf(hook: LocalHook, call: LocalWebhookCall): AutomationRunEvent {
  return {
    triggerId: webhookRuleId(hook.hookId),
    source: 'webhook',
    event: 'call',
    key: call.callId,
    occurredAt: call.envelope.receivedAt
  }
}
