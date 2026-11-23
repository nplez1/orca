// The answers a `WebhookHostService` asks, for a hook this computer serves: its card, its calls, the
// body a run quotes, and the token its URL carries. Every question about a cloud hook goes to the cloud.
import type { Automation } from '../../../shared/automations/automation-definition'
import { hookIdOfRule, type WebhookCallState } from '../../../shared/connector-webhook-contract'
import type { WebhookEnvelope, WebhookView } from '../../../shared/connector-webhook-routes'
import type { WebhookCallRow } from '../../../shared/rpc-contract/webhooks-params'
import {
  UNREADABLE_ANSWER,
  type ConnectorResult
} from '../../connector-cloud/connector-cloud-request'
import { automationWebhookTrigger } from '../../../shared/automation-event-triggers'
import type { WebhookCloudCalls } from '../webhook-cloud-routes'
import type { LedgerCall, WebhookHostLedger } from '../webhook-host-ledger'
import type { LocalWebhookListener } from './local-webhook-listener'
import type { LocalHook, LocalWebhookStore } from './local-webhook-store'

export type LocalWebhookRoutesDeps = {
  cloud: WebhookCloudCalls
  store: LocalWebhookStore
  ledger: WebhookHostLedger
  automations: () => readonly Automation[]
  listener: () => LocalWebhookListener
}

const ok = <T>(value: T): Promise<ConnectorResult<T>> => Promise.resolve({ ok: true, value })
/** Nothing here rotates, samples or takes a pasted secret: those are the cloud hook's own routes. */
const notLocal = <T>(): Promise<ConnectorResult<T>> => Promise.resolve({ ...UNREADABLE_ANSWER })

/** Whether an automation on this host still lists this hook's rule, for this bot. */
export function localHookListed(
  automations: () => readonly Automation[],
  hook: LocalHook
): boolean {
  const automation = automations().find((entry) => entry.id === hook.automationId)
  const rule = automation ? automationWebhookTrigger(automation) : undefined
  return (
    automation?.bot?.botId === hook.botId && (rule ? hookIdOfRule(rule.id) : null) === hook.hookId
  )
}

/** `received` is the ledger's own state; a hook's row calls it queued, as the cloud's rows do. */
function callState(call: Pick<LedgerCall, 'state'>): WebhookCallState {
  return call.state === 'received' ? 'queued' : call.state
}

function viewOf(deps: LocalWebhookRoutesDeps, hookId: string): WebhookView {
  const hook = deps.store.hook(hookId)
  if (!hook) {
    throw new Error('webhook_not_found')
  }
  // Nothing is served while the listener is down, and a made-up port would be a URL that 404s.
  const url = deps.listener().url(hookId)
  if (url === null) {
    throw new Error('webhooks_unavailable')
  }
  const automation = deps.automations().find((entry) => entry.id === hook.automationId)
  const calls = deps.ledger.calls().filter((entry) => entry.hookId === hookId)
  const last = calls.reduce<LedgerCall | null>(
    (newest, call) => (newest === null || call.occurredAt > newest.occurredAt ? call : newest),
    null
  )
  return {
    hookId,
    automationId: hook.automationId,
    botId: hook.botId,
    state: automation?.enabled === false ? 'paused' : 'live',
    epoch: hook.epoch,
    keyGeneration: 1,
    // A loopback URL's token is the whole of its auth and cannot be revealed on click like a cloud key.
    url: `${url}/${hook.token}`,
    adapter: null,
    previousKeyExpiresAt: null,
    lastCall: last ? { at: last.occurredAt, state: callState(last), signatureValid: false } : null,
    pendingCalls: calls.filter(
      (call) => call.state === 'received' || call.state === 'waiting_capacity'
    ).length
  }
}

function callRowsOf(deps: LocalWebhookRoutesDeps, hookId: string): WebhookCallRow[] {
  return deps.ledger
    .calls()
    .filter((call) => call.hookId === hookId)
    .sort((left, right) => right.occurredAt - left.occurredAt)
    .map((call) => ({
      kind: 'call' as const,
      callId: call.callId,
      receivedAt: call.occurredAt,
      state: callState(call),
      ...(call.sample ? { sample: true as const } : {}),
      ...(call.runId ? { runId: call.runId } : {}),
      ...(call.reason ? { reason: call.reason } : {})
    }))
}

/** Every hook's complete URL, which only the endpoint file's per-computer token opens. */
export function localWebhookUrls(
  deps: Pick<LocalWebhookRoutesDeps, 'store' | 'listener'>
): readonly { hookId: string; url: string }[] {
  return deps.store.hooks().flatMap((hook) => {
    const base = deps.listener().url(hook.hookId)
    return base ? [{ hookId: hook.hookId, url: `${base}/${hook.token}` }] : []
  })
}

/** A kept call's body; a body that went with its row is told as gone, so the run forgets the call. */
async function envelopeOf(
  deps: LocalWebhookRoutesDeps,
  callId: string
): Promise<ConnectorResult<WebhookEnvelope>> {
  const envelope = await deps.store.envelope(callId)
  return envelope ? ok(envelope) : { ok: false, status: 404, error: null, retryAfterMs: null }
}

export function localWebhookRoutes(deps: LocalWebhookRoutesDeps): WebhookCloudCalls {
  const { cloud } = deps
  const local = (id: string): boolean =>
    deps.store.hook(id) !== undefined || deps.store.call(id) !== undefined
  return {
    ...cloud,
    list: async (botId) => {
      const listening = deps.listener().listening()
      const here = deps.store
        .hooks()
        .filter((hook) => hook.botId === botId && localHookListed(deps.automations, hook))
        .flatMap((hook) => (listening ? [viewOf(deps, hook.hookId)] : []))
      const remote = await cloud.list(botId)
      if (here.length === 0) {
        return remote ?? { ok: true, value: { hooks: [] } }
      }
      return { ok: true, value: { hooks: [...here, ...(remote?.ok ? remote.value.hooks : [])] } }
    },
    get: (hookId) => (local(hookId) ? ok(viewOf(deps, hookId)) : cloud.get(hookId)),
    setState: (hookId, body) =>
      local(hookId) ? ok(viewOf(deps, hookId)) : cloud.setState(hookId, body),
    // A cloud hook's remove is the cloud's answer, so a null one is retried rather than read as done.
    remove: (hookId) => (local(hookId) ? ok(undefined) : cloud.remove(hookId)),
    calls: (hookId) =>
      local(hookId) ? ok({ calls: callRowsOf(deps, hookId) }) : cloud.calls(hookId),
    reveal: (hookId, body) =>
      local(hookId)
        ? ok({ key: deps.store.hook(hookId)?.token ?? '' })
        : cloud.reveal(hookId, body),
    envelope: (callId) => (local(callId) ? envelopeOf(deps, callId) : cloud.envelope(callId)),
    start: (callId, runId) =>
      deps.ledger.call(callId) ? ok({ started: true as const }) : cloud.start(callId, runId),
    sample: (hookId, operationId) =>
      local(hookId) ? notLocal() : cloud.sample(hookId, operationId),
    rotate: (hookId, body) => (local(hookId) ? notLocal() : cloud.rotate(hookId, body)),
    setSecret: (hookId, body) => (local(hookId) ? notLocal() : cloud.setSecret(hookId, body))
  }
}
