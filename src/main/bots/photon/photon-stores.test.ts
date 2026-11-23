import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PhotonInboundMessage } from './photon-contract'
import { PhotonCursorStore } from './photon-cursor'
import { PhotonInbox } from './photon-inbox'
import { PhotonOutbox, PHOTON_OUTBOX_MAX_ATTEMPTS } from './photon-outbox'
import { PhotonStore } from './photon-store'
import { PhotonThreadMap } from './photon-thread-map'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-photon-'))
})
afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

const message = (over: Partial<PhotonInboundMessage> = {}): PhotonInboundMessage => ({
  id: 'msg_1',
  conversationId: 'conv_1',
  sender: { handle: '+15551230000', name: 'Sam' },
  text: 'is the build green?',
  createdAt: 1000,
  ...over
})

describe('the account key and a bot’s project key', () => {
  it('holds the account key for the session when the owner did not opt in, and writes nothing', () => {
    const store = new PhotonStore(userDataPath)
    store.saveAccount({ organizationId: 'org_1', storesKey: false }, 'pho_ask_secret')

    // The default path has to work: a toggle that must be on before anything runs makes "off" broken.
    expect(store.accountCredential()).toEqual({ kind: 'account', key: 'pho_ask_secret' })
    expect(store.account()).toEqual({ organizationId: 'org_1', storesKey: false })
    // Nothing about the key reached the disk, which is what "not stored" means.
    expect(JSON.parse(readFileSync(store.recordPath, 'utf-8'))).toMatchObject({
      account: { organizationId: 'org_1' }
    })
    expect(JSON.parse(readFileSync(store.secretsPath, 'utf-8')).accountKey).toBeUndefined()
  })

  it('forgets a session-held account key across a restart, which is what the copy says', () => {
    const first = new PhotonStore(userDataPath)
    first.saveAccount({ organizationId: 'org_1', storesKey: false }, 'pho_ask_secret')
    expect(first.accountCredential()).not.toBeNull()

    const restarted = new PhotonStore(userDataPath)
    expect(restarted.account()).toEqual({ organizationId: 'org_1', storesKey: false })
    expect(restarted.accountCredential()).toBeNull()
  })

  it('persists the account key when the owner opts in, and forgets it when they opt out', () => {
    const store = new PhotonStore(userDataPath)
    store.saveAccount({ organizationId: 'org_1', storesKey: true }, 'pho_ask_secret')
    expect(store.accountKey()).toBe('pho_ask_secret')

    // A restart still has it, which is the whole point of opting in.
    expect(new PhotonStore(userDataPath).accountKey()).toBe('pho_ask_secret')

    store.saveAccount({ organizationId: 'org_1', storesKey: false }, undefined)
    expect(JSON.parse(readFileSync(store.secretsPath, 'utf-8')).accountKey).toBeUndefined()
    expect(new PhotonStore(userDataPath).accountKey()).toBeNull()
  })

  it('seals a persisted key rather than writing it as plaintext', () => {
    const store = new PhotonStore(userDataPath)
    store.saveAccount({ organizationId: 'org_1', storesKey: true }, 'pho_ask_secret')

    const written = readFileSync(store.secretsPath, 'utf-8')
    expect(written).not.toMatch(/pho_ask_secret/)
    expect(JSON.parse(written).accountKey).toMatch(/^(sealed|plain):/)
  })

  it('is not connected when neither a stored nor a session key is available', () => {
    const store = new PhotonStore(userDataPath)
    store.saveAccount({ organizationId: 'org_1', storesKey: false }, undefined)
    expect(store.account()).not.toBeNull()
    expect(store.accountCredential()).toBeNull()
  })

  it('refuses to overwrite an unreadable record instead of orphaning its projects', () => {
    const store = new PhotonStore(userDataPath)
    store.putBot({ botId: 'b1', projectId: 'p1', slug: 'orca-bot-one', organizationId: 'org_1' })
    mkdirSync(join(userDataPath, 'local-photon'), { recursive: true })
    writeFileSync(store.recordPath, '{ not json')

    const reopened = new PhotonStore(userDataPath)
    expect(() =>
      reopened.putBot({
        botId: 'b2',
        projectId: 'p2',
        slug: 'orca-bot-two',
        organizationId: 'org_1'
      })
    ).toThrow(/will not overwrite it/)
    // The file is still there, still unreadable, and still the only copy of what it named.
    expect(readFileSync(store.recordPath, 'utf-8')).toBe('{ not json')
  })

  it('never logs the text of an unreadable secrets file, which is part of a key', () => {
    const store = new PhotonStore(userDataPath)
    mkdirSync(join(userDataPath, 'local-photon'), { recursive: true })
    writeFileSync(store.secretsPath, '{"accountKey":"sealed:AAAA",')
    const logged: unknown[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => {
      logged.push(args)
    }
    try {
      const reopened = new PhotonStore(userDataPath)
      try {
        reopened.saveAccount({ organizationId: 'org_1', storesKey: true }, 'pho_ask_secret')
      } catch {
        // Refused, which is the point; the log is what this test is about.
      }
    } finally {
      console.warn = original
    }
    expect(JSON.stringify(logged)).not.toMatch(/sealed:AAAA/)
  })

  it('keeps each bot’s project key to that bot, and never puts it in the ordinary record', () => {
    const store = new PhotonStore(userDataPath)
    store.putBot({ botId: 'b1', projectId: 'p1', slug: 'orca-bot-one', organizationId: 'org_1' })
    store.putBot({ botId: 'b2', projectId: 'p2', slug: 'orca-bot-two', organizationId: 'org_1' })
    store.putProjectKey('b1', { keyId: 'k1', secret: 'pho_sk_one' })
    store.putProjectKey('b2', { keyId: 'k2', secret: 'pho_sk_two' })

    expect(store.projectCredential('b1')).toEqual({ kind: 'project', key: 'pho_sk_one' })
    expect(store.projectCredential('b2')).toEqual({ kind: 'project', key: 'pho_sk_two' })
    expect(readFileSync(store.recordPath, 'utf-8')).not.toContain('pho_sk_')

    store.forgetBot('b1')
    expect(store.projectKey('b1')).toBeNull()
    expect(store.projectKey('b2')).toEqual({ keyId: 'k2', secret: 'pho_sk_two' })
    expect(store.bot('b1')).toBeNull()
  })
})

describe('the inbox, which is both the crash guard and the dedupe index', () => {
  it('runs a message the first time and skips the same id the second time', () => {
    const store = new PhotonStore(userDataPath)
    const inbox = new PhotonInbox(store)
    const first = inbox.claim('p1', message())
    expect(first.action).toBe('run')

    inbox.markHandled('p1', 'msg_1')
    const second = inbox.claim('p1', message())
    expect(second.action).toBe('skip')
  })

  it('runs again when a crash landed between the write and the dispatch', () => {
    const store = new PhotonStore(userDataPath)
    const inbox = new PhotonInbox(store)
    inbox.claim('p1', message())

    // No markHandled: the process died before the turn was handed over.
    const replay = new PhotonInbox(new PhotonStore(userDataPath)).claim('p1', message())
    expect(replay.action).toBe('run')
    expect(replay.entry.text).toBe('is the build green?')
  })

  it('writes the payload to disk before the caller can start anything', () => {
    const store = new PhotonStore(userDataPath)
    const inbox = new PhotonInbox(store)
    inbox.claim('p1', message())
    // A second, independent reader sees it, so the write is on disk rather than in memory only.
    expect(JSON.parse(readFileSync(store.inboxPath('p1', 'msg_1'), 'utf-8'))).toMatchObject({
      messageId: 'msg_1',
      conversationId: 'conv_1',
      text: 'is the build green?'
    })
  })

  it('refuses a message id that could escape its directory', () => {
    const inbox = new PhotonInbox(new PhotonStore(userDataPath))
    expect(() => inbox.claim('p1', message({ id: '../../etc/passwd' }))).toThrow(/not usable/)
  })
})

describe('the cursor, which is the handoff checkpoint', () => {
  it('starts at zero, which Photon reads as new events only', () => {
    expect(new PhotonCursorStore(new PhotonStore(userDataPath)).read('p1')).toBe(0)
  })

  it('refuses to advance past a message the inbox does not hold', () => {
    const store = new PhotonStore(userDataPath)
    const cursors = new PhotonCursorStore(store)
    const inbox = new PhotonInbox(store)

    const refused = cursors.advance('p1', 41, {
      inboxHas: (id) => inbox.has('p1', id),
      messageId: 'msg_1'
    })
    expect(refused).toEqual({ advanced: false, reason: 'not-in-inbox' })
    // The refusal is the assertion: advancing on receipt would be a data-loss bug, and it did not happen.
    expect(cursors.read('p1')).toBe(0)
  })

  it('advances once the message is in the inbox, and resumes from a gap without assuming +1', () => {
    const store = new PhotonStore(userDataPath)
    const cursors = new PhotonCursorStore(store)
    const inbox = new PhotonInbox(store)
    inbox.claim('p1', message({ id: 'msg_41' }))
    inbox.claim('p1', message({ id: 'msg_47' }))

    expect(
      cursors.advance('p1', 41, { inboxHas: (id) => inbox.has('p1', id), messageId: 'msg_41' })
    ).toEqual({ advanced: true, seq: 41 })
    // 42..46 never arrived, and nothing invents them: the next cursor is the one Photon named.
    expect(
      cursors.advance('p1', 47, { inboxHas: (id) => inbox.has('p1', id), messageId: 'msg_47' })
    ).toEqual({ advanced: true, seq: 47 })
    expect(cursors.read('p1')).toBe(47)
    expect(cursors.read('p1') + 1).toBe(48)
  })

  it('never moves backwards, because a rewind is a bug rather than a re-read', () => {
    const store = new PhotonStore(userDataPath)
    const cursors = new PhotonCursorStore(store)
    const inbox = new PhotonInbox(store)
    inbox.claim('p1', message({ id: 'msg_41' }))
    inbox.claim('p1', message({ id: 'msg_47' }))
    cursors.advance('p1', 47, { inboxHas: (id) => inbox.has('p1', id), messageId: 'msg_47' })

    expect(
      cursors.advance('p1', 41, { inboxHas: (id) => inbox.has('p1', id), messageId: 'msg_41' })
    ).toEqual({ advanced: false, reason: 'behind-stored-cursor', stored: 47 })
    expect(cursors.read('p1')).toBe(47)
  })

  it('keeps one cursor per project and per consumer purpose', () => {
    const store = new PhotonStore(userDataPath)
    const cursors = new PhotonCursorStore(store)
    const inbox = new PhotonInbox(store)
    inbox.claim('p1', message({ id: 'msg_41' }))
    cursors.advance('p1', 41, { inboxHas: (id) => inbox.has('p1', id), messageId: 'msg_41' })

    expect(cursors.read('p1', 'another-integration')).toBe(0)
    expect(cursors.read('p2')).toBe(0)
  })
})

describe('the thread map', () => {
  it('continues one chat for one conversation and starts another for a new one', () => {
    const store = new PhotonStore(userDataPath)
    const threads = new PhotonThreadMap(store)
    threads.bind('b1', 'conv_1', { chatId: 'chat_1', handle: '+15551230000' })

    expect(threads.chatIdFor('b1', 'conv_1')).toBe('chat_1')
    expect(threads.chatIdFor('b1', 'conv_2')).toBeNull()
    expect(threads.knows('b1', 'conv_2')).toBe(false)
  })

  it('survives a restart, so a mid-conversation restart continues rather than restarting', () => {
    const store = new PhotonStore(userDataPath)
    new PhotonThreadMap(store).bind('b1', 'conv_1', { chatId: 'chat_1', handle: '+15551230000' })

    expect(new PhotonThreadMap(new PhotonStore(userDataPath)).chatIdFor('b1', 'conv_1')).toBe(
      'chat_1'
    )
  })

  it('reports a different pool line for the same conversation without losing the chat', () => {
    const threads = new PhotonThreadMap(new PhotonStore(userDataPath))
    threads.bind('b1', 'conv_1', {
      chatId: 'chat_1',
      handle: '+15551230000',
      phoneNumber: '+15550101'
    })
    threads.bind('b1', 'conv_1', {
      chatId: 'chat_1',
      handle: '+15551230000',
      phoneNumber: '+15550202'
    })

    expect(threads.thread('b1', 'conv_1')).toMatchObject({
      chatId: 'chat_1',
      phoneNumber: '+15550202'
    })
  })
})

describe('the outbox', () => {
  it('keeps a failed send and retries it rather than letting the result vanish', () => {
    const outbox = new PhotonOutbox(new PhotonStore(userDataPath))
    outbox.enqueue({ id: 's1', botId: 'b1', projectId: 'p1', conversationId: 'c1', body: 'done' })

    outbox.fail('s1', 'socket hang up')
    expect(outbox.pendingFor('b1')).toEqual([
      expect.objectContaining({ id: 's1', attempts: 1, lastError: 'socket hang up' })
    ])

    outbox.settle('s1')
    expect(outbox.pendingFor('b1')).toEqual([])
  })

  it('does not enqueue the same send twice', () => {
    const outbox = new PhotonOutbox(new PhotonStore(userDataPath))
    outbox.enqueue({ id: 's1', botId: 'b1', projectId: 'p1', conversationId: 'c1', body: 'done' })
    outbox.enqueue({ id: 's1', botId: 'b1', projectId: 'p1', conversationId: 'c1', body: 'done' })
    expect(outbox.entries()).toHaveLength(1)
  })

  it('gives up after the attempt cap instead of retrying a stale answer forever', () => {
    const outbox = new PhotonOutbox(new PhotonStore(userDataPath))
    outbox.enqueue({ id: 's1', botId: 'b1', projectId: 'p1', conversationId: 'c1', body: 'done' })
    for (let attempt = 0; attempt < PHOTON_OUTBOX_MAX_ATTEMPTS; attempt += 1) {
      outbox.fail('s1', 'still failing')
    }
    expect(outbox.entries()).toEqual([])
  })
})
