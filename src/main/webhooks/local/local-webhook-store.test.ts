import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WebhookEnvelope } from '../../../shared/connector-webhook-routes'
import {
  LOCAL_MINT_GRACE_MS,
  LOCAL_WEBHOOK_DIR,
  LOCAL_WEBHOOK_EPOCH,
  LocalWebhookStore,
  type LocalHook
} from './local-webhook-store'

const HOOK = 'wh_7Kx2pQ9mZbV4tL1r'
const CALL = 'call_0123456789abcdefABC1'
const OTHER_CALL = 'call_0123456789abcdefABC2'

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
  it('keeps a hook and its calls across a restart, in a file only this user can read', async () => {
    const store = new LocalWebhookStore(userDataPath)
    await store.putHook(hook())
    await store.putCall({ callId: CALL, hookId: HOOK, createdAt: 10 }, envelope('opened'))

    const reopened = new LocalWebhookStore(userDataPath)
    await reopened.load()
    expect(reopened.hook(HOOK)).toEqual(hook())
    expect((await reopened.envelope(CALL))?.body).toEqual({
      kind: 'json',
      value: { action: 'opened' }
    })
    if (process.platform !== 'win32') {
      expect(statSync(reopened.path).mode & 0o777).toBe(0o600)
      expect(statSync(join(userDataPath, LOCAL_WEBHOOK_DIR)).mode & 0o777).toBe(0o700)
      expect(statSync(reopened.bodyPath(CALL)).mode & 0o777).toBe(0o600)
    }
  })

  it('keeps each body in its own file, so a delivery never rewrites what the others hold', async () => {
    const store = new LocalWebhookStore(userDataPath)
    await store.putHook(hook())
    await store.putCall({ callId: CALL, hookId: HOOK, createdAt: 10 }, envelope('opened'))
    const index = readFileSync(store.path, 'utf8')
    expect(index).not.toContain('opened')

    await store.putCall(
      { callId: 'call_0123456789abcdefABC2', hookId: HOOK, createdAt: 11 },
      envelope('labeled')
    )
    expect(readFileSync(store.path, 'utf8')).not.toContain('opened')
    expect((await store.envelope('call_0123456789abcdefABC2'))?.body).toEqual({
      kind: 'json',
      value: { action: 'labeled' }
    })
    expect((await store.envelope(CALL))?.body).toEqual({
      kind: 'json',
      value: { action: 'opened' }
    })
  })

  it('drops a call’s body with its row, and a hook with everything waiting for it', async () => {
    const store = new LocalWebhookStore(userDataPath)
    await store.putHook(hook())
    await store.putCall({ callId: CALL, hookId: HOOK, createdAt: 10 }, envelope('opened'))
    await store.dropCall(CALL)
    expect(store.call(CALL)).toBeUndefined()
    expect(await store.envelope(CALL)).toBeUndefined()

    await store.putCall({ callId: CALL, hookId: HOOK, createdAt: 10 }, envelope('opened'))
    await store.dropHook(HOOK)
    expect(store.hooks()).toEqual([])
    expect(store.calls()).toEqual([])
    expect(store.intents()).toEqual([])
    expect(await store.envelope(CALL)).toBeUndefined()
  })

  it('keeps a minted hook’s intent until the automation that names it is listed', async () => {
    const store = new LocalWebhookStore(userDataPath)
    await store.putHook(hook())
    await store.saveIntent({ automationId: 'a1', hookId: HOOK, createdAt: 1 })
    const reopened = new LocalWebhookStore(userDataPath)
    await reopened.load()
    expect(reopened.intents()).toEqual([{ automationId: 'a1', hookId: HOOK, createdAt: 1 }])
    await store.dropIntent(HOOK)
    expect(store.intents()).toEqual([])
    expect(LOCAL_MINT_GRACE_MS).toBe(10 * 60 * 1000)
  })

  it('keeps both rows when two deliveries are written at once', async () => {
    const store = new LocalWebhookStore(userDataPath)
    await store.putHook(hook())
    // Both start from the same index; a store that clones before it queues loses whichever lands first.
    const [first, second] = await Promise.all([
      store.putCall({ callId: CALL, hookId: HOOK, createdAt: 10 }, envelope('opened')),
      store.putCall({ callId: OTHER_CALL, hookId: HOOK, createdAt: 11 }, envelope('labeled'))
    ])
    expect([first, second]).toEqual([true, true])
    expect(
      store
        .calls()
        .map((entry) => entry.callId)
        .sort()
    ).toEqual([CALL, OTHER_CALL].sort())
    // And on disk, not only in memory.
    const reopened = new LocalWebhookStore(userDataPath)
    await reopened.load()
    expect(
      reopened
        .calls()
        .map((entry) => entry.callId)
        .sort()
    ).toEqual([CALL, OTHER_CALL].sort())
    expect((await reopened.envelope(OTHER_CALL))?.body).toEqual({
      kind: 'json',
      value: { action: 'labeled' }
    })
  })

  it('cannot bring a dropped hook back from a write that was already in flight', async () => {
    const store = new LocalWebhookStore(userDataPath)
    await store.putHook(hook())
    // A delivery and the drop of the hook it belongs to, queued in that order: the drop is last and wins.
    const delivering = store.putCall(
      { callId: CALL, hookId: HOOK, createdAt: 10 },
      envelope('opened')
    )
    const dropping = store.dropHook(HOOK)
    await Promise.all([delivering, dropping])
    expect(store.hooks()).toEqual([])
    expect(store.calls()).toEqual([])
    const reopened = new LocalWebhookStore(userDataPath)
    await reopened.load()
    expect(reopened.hooks()).toEqual([])
    expect(reopened.calls()).toEqual([])
  })

  it('refuses a call whose hook went before its body was written', async () => {
    const store = new LocalWebhookStore(userDataPath)
    await store.putHook(hook())
    await store.dropHook(HOOK)
    expect(
      await store.putCall({ callId: CALL, hookId: HOOK, createdAt: 10 }, envelope('opened'))
    ).toBe(false)
    expect(store.calls()).toEqual([])
    expect(await store.envelope(CALL)).toBeUndefined()
  })

  it('replaces a hook it already knows rather than listing it twice', async () => {
    const store = new LocalWebhookStore(userDataPath)
    await store.putHook(hook())
    await store.putHook({ ...hook(), automationId: 'a2' })
    expect(store.hooks()).toEqual([{ ...hook(), automationId: 'a2' }])
  })

  it('prunes only what nothing owns, and writes nothing when there is nothing to prune', async () => {
    const store = new LocalWebhookStore(userDataPath)
    await store.putHook(hook())
    await store.putCall({ callId: CALL, hookId: HOOK, createdAt: 10 }, envelope('opened'))
    const before = statSync(store.path).mtimeMs

    await store.prune(() => true, new Set([CALL]))
    expect(statSync(store.path).mtimeMs).toBe(before)

    await store.prune(() => false, new Set())
    expect(store.hooks()).toEqual([])
    expect(store.calls()).toEqual([])
    expect(await store.envelope(CALL)).toBeUndefined()
  })
})
