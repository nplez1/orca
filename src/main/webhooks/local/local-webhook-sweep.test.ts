// Two sweeps walk the same bot folders: Orca Cloud's and this computer's. Each must leave the other's
// call files alone, or a run that outlives the unowned grace loses the file its prompt points at.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webhookCallFileName } from '../webhook-call-file'
import { WebhookHostLedger } from '../webhook-host-ledger'
import { WebhookRecoverySweep } from '../webhook-recovery-sweep'
import { LOCAL_WEBHOOK_DIR, LocalWebhookStore } from './local-webhook-store'

const HOOK = 'wh_7Kx2pQ9mZbV4tL1r'
const LOCAL_CALL = 'call_0123456789abcdefABC1'
const CLOUD_CALL = 'call_0123456789abcdefABC2'
/** A fixed instant, so nothing here reads the wall clock: the sweep's `Date.now()` is faked to it. */
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0)
/** Older than the hour an unowned file is given, which is what a long run looks like. */
const TWO_HOURS_AGO = new Date(NOW - 2 * 60 * 60 * 1000)

let userDataPath: string
let botFolder: string

const localPath = (callId: string) => join(botFolder, webhookCallFileName(callId))

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-local-webhooks-sweep-'))
  botFolder = join(userDataPath, 'bots', 'scout')
  mkdirSync(join(botFolder, 'webhook-calls'), { recursive: true })
  for (const callId of [LOCAL_CALL, CLOUD_CALL]) {
    writeFileSync(localPath(callId), '{}', { mode: 0o600 })
    utimesSync(localPath(callId), TWO_HOURS_AGO, TWO_HOURS_AGO)
  }
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(userDataPath, { recursive: true, force: true })
})

/** Orca Cloud's sweep: its own ledger, the shared folders, and whatever else owns files there. */
function cloudSweep(alsoOwned?: () => ReadonlySet<string>): WebhookRecoverySweep {
  const ledger = new WebhookHostLedger(userDataPath, () => 'acct-1', alsoOwned)
  ledger.receive(
    {
      callId: CLOUD_CALL,
      hookId: HOOK,
      automationId: 'a1',
      triggerId: `wh-${HOOK}`,
      occurredAt: 1,
      epoch: 1
    },
    1
  )
  ledger.bind(CLOUD_CALL, { file: localPath(CLOUD_CALL) })
  return new WebhookRecoverySweep({
    ledger,
    settleRuns: () => {},
    reconcileHooks: () => {},
    botFolders: () => [botFolder]
  })
}

describe('the call-file sweeps', () => {
  it('leaves this computer’s call file alone when Orca Cloud sweeps the bot folder', async () => {
    const store = new LocalWebhookStore(userDataPath)
    await store.putHook({
      hookId: HOOK,
      token: 't'.repeat(43),
      automationId: 'a2',
      botId: 'bot-1',
      epoch: 1,
      created: 1
    })
    await store.putCall(
      { callId: LOCAL_CALL, hookId: HOOK, createdAt: 1 },
      {
        receivedAt: 1,
        contentType: 'application/json',
        headers: {},
        body: { kind: 'json', value: {} },
        truncated: false
      }
    )
    const localLedger = new WebhookHostLedger(join(userDataPath, LOCAL_WEBHOOK_DIR), () => 'local')
    localLedger.saveHook({
      hookId: HOOK,
      automationId: 'a2',
      botId: 'bot-1',
      epoch: 1,
      state: 'live'
    })
    localLedger.receive(
      {
        callId: LOCAL_CALL,
        hookId: HOOK,
        automationId: 'a2',
        triggerId: `wh-${HOOK}`,
        occurredAt: 1,
        epoch: 1
      },
      1
    )
    localLedger.bind(LOCAL_CALL, { file: localPath(LOCAL_CALL) })

    await cloudSweep(() => localLedger.files()).start()
    expect(readdirSync(join(botFolder, 'webhook-calls')).sort()).toEqual(
      [LOCAL_CALL, CLOUD_CALL].map((callId) => `${callId}.untrusted.json`).sort()
    )
  })

  it('would delete it when the sweep is told nothing about this computer’s files', async () => {
    // The R1 shape, kept as the proof that the case above is the one that bites.
    await cloudSweep().start()
    expect(readdirSync(join(botFolder, 'webhook-calls'))).toEqual([`${CLOUD_CALL}.untrusted.json`])
  })
})
