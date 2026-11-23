import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WebhookEnvelope } from '../../../shared/connector-webhook-routes'
import {
  LOCAL_WEBHOOK_DIR,
  LOCAL_WEBHOOK_EPOCH,
  LocalWebhookStore,
  type LocalHook
} from './local-webhook-store'

const HOOK = 'wh_7Kx2pQ9mZbV4tL1r'
const CALL = 'call_0123456789abcdefABC1'

const hook = (hookId = HOOK): LocalHook => ({
  hookId,
  token: 'a'.repeat(43),
  automationId: 'a1',
  botId: 'bot-1',
  epoch: LOCAL_WEBHOOK_EPOCH,
  created: 1
})

const envelope = (action: string): WebhookEnvelope => ({
  receivedAt: 10,
  contentType: 'application/json',
  headers: { 'x-github-delivery': 'd1' },
  body: { kind: 'json', value: { action } },
  truncated: false
})

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-local-webhooks-'))
})
afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('the local webhook store', () => {
  it('keeps a hook and its calls across a restart, in a file only this user can read', () => {
    const store = new LocalWebhookStore(userDataPath)
    store.putHook(hook())
    store.putCall({ callId: CALL, hookId: HOOK, envelope: envelope('opened') })

    const reopened = new LocalWebhookStore(userDataPath)
    expect(reopened.hook(HOOK)).toEqual(hook())
    expect(reopened.call(CALL)?.envelope.body).toEqual({
      kind: 'json',
      value: { action: 'opened' }
    })
    if (process.platform !== 'win32') {
      expect(statSync(reopened.path).mode & 0o777).toBe(0o600)
      expect(statSync(join(userDataPath, LOCAL_WEBHOOK_DIR)).mode & 0o777).toBe(0o700)
    }
  })

  it('replaces a hook it already knows rather than listing it twice', () => {
    const store = new LocalWebhookStore(userDataPath)
    store.putHook(hook())
    store.putHook({ ...hook(), automationId: 'a2' })
    expect(store.hooks()).toEqual([{ ...hook(), automationId: 'a2' }])
  })

  it('drops a hook together with the calls still waiting for it', () => {
    const store = new LocalWebhookStore(userDataPath)
    store.putHook(hook())
    store.putCall({ callId: CALL, hookId: HOOK, envelope: envelope('opened') })
    store.dropHook(HOOK)
    expect(store.hooks()).toEqual([])
    expect(store.calls()).toEqual([])
  })

  it('prunes only what nothing owns, and writes nothing when there is nothing to prune', () => {
    const store = new LocalWebhookStore(userDataPath)
    store.putHook(hook())
    store.putCall({ callId: CALL, hookId: HOOK, envelope: envelope('opened') })
    const before = statSync(store.path).mtimeMs

    store.prune(() => true, new Set([CALL]))
    expect(statSync(store.path).mtimeMs).toBe(before)

    store.prune(() => false, new Set())
    expect(store.hooks()).toEqual([])
    expect(store.calls()).toEqual([])
  })
})
