import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PhotonInboundMessage } from './photon-contract'
import { PhotonCursorStore } from './photon-cursor'
import { PhotonInbox } from './photon-inbox'
import { PhotonOutbox, PHOTON_OUTBOX_HORIZON_MS } from './photon-outbox'
import { PhotonStore } from './photon-store'
import { photonPathSegment } from './photon-store-paths'
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

/** The secrets file's contents, or null when the store wrote none: nothing changed, so nothing is written. */
function secretsOf(store: PhotonStore): { accountKey?: string } | null {
  try {
    return JSON.parse(readFileSync(store.secretsPath, 'utf-8'))
  } catch {
    return null
  }
}

describe('the account key and a bot’s project key', () => {
  it('holds the account key for the session when the owner did not opt in, and writes nothing', async () => {
    const store = new PhotonStore(userDataPath)
    await store.saveAccount({ organizationId: 'org_1', storesKey: false }, 'pho_ask_secret')

    // The default path has to work: a toggle that must be on before anything runs makes "off" broken.
    expect(await store.accountCredential()).toEqual({ kind: 'account', key: 'pho_ask_secret' })
    expect(await store.account()).toEqual({ organizationId: 'org_1', storesKey: false })
    // Nothing about the key reached the disk, which is what "not stored" means.
    expect(JSON.parse(readFileSync(store.recordPath, 'utf-8'))).toMatchObject({
      account: { organizationId: 'org_1' }
    })
    expect(secretsOf(store)?.accountKey).toBeUndefined()
  })

  it('forgets a session-held account key across a restart, which is what the copy says', async () => {
    const first = new PhotonStore(userDataPath)
    await first.saveAccount({ organizationId: 'org_1', storesKey: false }, 'pho_ask_secret')
    expect(await first.accountCredential()).not.toBeNull()

    const restarted = new PhotonStore(userDataPath)
    expect(await restarted.account()).toEqual({ organizationId: 'org_1', storesKey: false })
    expect(await restarted.accountCredential()).toBeNull()
  })

  it('persists the account key when the owner opts in, and forgets it when they opt out', async () => {
    const store = new PhotonStore(userDataPath)
    await store.saveAccount({ organizationId: 'org_1', storesKey: true }, 'pho_ask_secret')
    expect(await store.accountKey()).toBe('pho_ask_secret')

    // A restart still has it, which is the whole point of opting in.
    expect(await new PhotonStore(userDataPath).accountKey()).toBe('pho_ask_secret')

    await store.saveAccount({ organizationId: 'org_1', storesKey: false }, undefined)
    expect(secretsOf(store)?.accountKey).toBeUndefined()
    expect(await new PhotonStore(userDataPath).accountKey()).toBeNull()
  })

  it('seals a persisted key rather than writing it as plaintext', async () => {
    const store = new PhotonStore(userDataPath)
    await store.saveAccount({ organizationId: 'org_1', storesKey: true }, 'pho_ask_secret')

    const written = readFileSync(store.secretsPath, 'utf-8')
    expect(written).not.toMatch(/pho_ask_secret/)
    expect(JSON.parse(written).accountKey).toMatch(/^(sealed|plain):/)
  })

  it('is not connected when neither a stored nor a session key is available', async () => {
    const store = new PhotonStore(userDataPath)
    await store.saveAccount({ organizationId: 'org_1', storesKey: false }, undefined)
    expect(await store.account()).not.toBeNull()
    expect(await store.accountCredential()).toBeNull()
  })

  it('refuses to overwrite an unreadable record instead of orphaning its projects', async () => {
    const store = new PhotonStore(userDataPath)
    await store.putBot({
      botId: 'b1',
      projectId: 'p1',
      slug: 'orca-bot-one',
      organizationId: 'org_1'
    })
    mkdirSync(join(userDataPath, 'local-photon'), { recursive: true })
    writeFileSync(store.recordPath, '{ not json')

    const reopened = new PhotonStore(userDataPath)
    await expect(
      reopened.putBot({
        botId: 'b2',
        projectId: 'p2',
        slug: 'orca-bot-two',
        organizationId: 'org_1'
      })
    ).rejects.toThrow(/will not overwrite it/)
    // The file is still there, still unreadable, and still the only copy of what it named.
    expect(readFileSync(store.recordPath, 'utf-8')).toBe('{ not json')
  })

  it('publishes a change only after the write lands, so a reader mid-write sees the disk', async () => {
    // The store's comment claimed this and the code did not give it: the mutation was applied to live
    // state for the whole write, so `bot()` could read a record that a failing write would then discard.
    // Here the write fails and the reader never sees the change at all.
    const store = new PhotonStore(userDataPath)
    await store.putBot({
      botId: 'b1',
      projectId: 'p1',
      slug: 'orca-bot-one',
      organizationId: 'org_1'
    })
    // A directory where the record file goes: every write to it fails, whatever the platform, and the
    // record was already loaded, so this is the write path and not the unreadable-file path.
    rmSync(store.recordPath, { force: true })
    mkdirSync(store.recordPath, { recursive: true })

    const failures: unknown[] = []
    const pending = store
      .putBot({ botId: 'b2', projectId: 'p2', slug: 'orca-bot-two', organizationId: 'org_1' })
      .catch((error: unknown) => failures.push(error))
    // A reader while the write is in flight: no b2, because nothing has been published.
    expect(await store.bot('b2')).toBeNull()
    await pending

    expect(failures).toHaveLength(1)
    // And after the failure the store still serves the record that is on disk.
    expect(await store.bot('b2')).toBeNull()
    expect((await store.bot('b1'))?.slug).toBe('orca-bot-one')
  })

  it('never logs the text of an unreadable secrets file, which is part of a key', async () => {
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

  it('keeps each bot’s project key to that bot, and never puts it in the ordinary record', async () => {
    const store = new PhotonStore(userDataPath)
    await store.putBot({
      botId: 'b1',
      projectId: 'p1',
      slug: 'orca-bot-one',
      organizationId: 'org_1'
    })
    await store.putBot({
      botId: 'b2',
      projectId: 'p2',
      slug: 'orca-bot-two',
      organizationId: 'org_1'
    })
    await store.putProjectKey('b1', { keyId: 'k1', secret: 'pho_sk_one' })
    await store.putProjectKey('b2', { keyId: 'k2', secret: 'pho_sk_two' })

    expect(await store.projectCredential('b1')).toEqual({ kind: 'project', key: 'pho_sk_one' })
    expect(await store.projectCredential('b2')).toEqual({ kind: 'project', key: 'pho_sk_two' })
    expect(readFileSync(store.recordPath, 'utf-8')).not.toContain('pho_sk_')

    await store.forgetBot('b1')
    expect(await store.projectKey('b1')).toBeNull()
    expect(await store.projectKey('b2')).toEqual({ keyId: 'k2', secret: 'pho_sk_two' })
    expect(await store.bot('b1')).toBeNull()
  })

  it('writes an account-mode record back unchanged, every field it was handed included', async () => {
    const store = new PhotonStore(userDataPath)
    const written = await store.putBot({
      mode: 'account',
      botId: 'b1',
      projectId: 'p1',
      slug: 'orca-bot-one',
      organizationId: 'org_1',
      completedThrough: 'assignment',
      keyId: 'k1',
      phoneNumber: '+15551230000',
      ownerHandle: '+15551230000',
      assignments: [{ assignmentId: 'a1', handle: '+15551230000', phoneNumber: '+15551230000' }],
      keyGeneration: 2,
      unknownSenderCount: 1,
      parkedMessageCount: 2,
      lastParkedReason: 'This chat is closed.',
      undeliveredAnswerCount: 1,
      lastUndeliveredReason: 'Photon answered 503.',
      createdAt: 1_700_000_000_000
    })

    // `putBot` parses what it is given, so this pins that the parse is lossless for the mode that has every
    // field, rather than silently dropping one a caller set.
    expect(await new PhotonStore(userDataPath).bot('b1')).toEqual(written)
    expect(written).toMatchObject({
      mode: 'account',
      keyGeneration: 2,
      assignments: [{ assignmentId: 'a1', handle: '+15551230000', phoneNumber: '+15551230000' }],
      lastUndeliveredReason: 'Photon answered 503.'
    })
  })

  it('refuses a record the schema would not read back, instead of writing one that goes unreadable', async () => {
    const store = new PhotonStore(userDataPath)
    await store.putBot({ botId: 'b1', projectId: 'p1', organizationId: 'org_1' })

    await expect(
      store.putBot({ botId: 'b2', projectId: '', organizationId: 'org_1' })
    ).rejects.toThrow()

    // Nothing was written, so the file the previous state named is still readable and still its own.
    const restarted = new PhotonStore(userDataPath)
    expect(await restarted.bot('b2')).toBeNull()
    expect(restarted.unreadable.record).toBe(false)
    expect((await restarted.bots()).map((entry) => entry.botId)).toEqual(['b1'])
  })
})

describe('the inbox, which is both the crash guard and the dedupe index', () => {
  it('runs a message the first time and skips the same id the second time', async () => {
    const store = new PhotonStore(userDataPath)
    const inbox = new PhotonInbox(store)
    const first = await inbox.claim('p1', message())
    expect(first.action).toBe('run')

    await inbox.markHandled('p1', 'msg_1')
    const second = await inbox.claim('p1', message())
    expect(second.action).toBe('skip')
  })

  it('runs again when a crash landed between the write and the dispatch', async () => {
    const store = new PhotonStore(userDataPath)
    const inbox = new PhotonInbox(store)
    await inbox.claim('p1', message())

    // No markHandled: the process died before the turn was handed over.
    const replay = await new PhotonInbox(new PhotonStore(userDataPath)).claim('p1', message())
    expect(replay.action).toBe('run')
    expect(replay.entry.text).toBe('is the build green?')
  })

  it('writes the payload to disk before the caller can start anything', async () => {
    const store = new PhotonStore(userDataPath)
    const inbox = new PhotonInbox(store)
    await inbox.claim('p1', message())
    // A second, independent reader sees it, so the write is on disk rather than in memory only.
    expect(JSON.parse(readFileSync(store.inboxPath('p1', 'msg_1'), 'utf-8'))).toMatchObject({
      messageId: 'msg_1',
      conversationId: 'conv_1',
      text: 'is the build green?'
    })
  })

  it('encodes a colon, which NTFS would turn into an alternate data stream', () => {
    // `a:b.json` is not a file name on NTFS: it opens a stream `readdir` never lists, so the write lands
    // somewhere the store cannot find again and the cursor stops at not-in-inbox. Photon's alphabet is
    // unpublished, so the character is encoded rather than assumed away.
    expect(photonPathSegment('msg:1')).toBe('msg%3A1')
    expect(photonPathSegment('msg%3A1')).not.toBe(photonPathSegment('msg:1'))
    expect(photonPathSegment('msg_1')).toBe('msg_1')
  })

  it('round-trips a colon id through a restart, so the store finds its own files again', async () => {
    // The encoder alone is not the property: a listing hands back *file names*, so a store that encodes
    // but never decodes reports `has(rawId)` false after a restart — the cursor sticks at that message —
    // and `unhandled()` asks for the encoded name again and opens `msg%253A1.json`, which does not exist.
    // A fresh store, with no in-memory set, is what a restart looks like.
    const first = new PhotonInbox(new PhotonStore(userDataPath))
    await first.claim('p1', message({ id: 'msg:1', text: 'hash: one' }), 41)
    await first.claim('p1', message({ id: 'msg_2' }), 47)

    const restarted = new PhotonInbox(new PhotonStore(userDataPath))
    expect(await restarted.has('p1', 'msg:1')).toBe(true)
    expect((await restarted.ids('p1')).sort()).toEqual(['msg:1', 'msg_2'])
    expect((await restarted.read('p1', 'msg:1'))?.text).toBe('hash: one')
    expect((await restarted.unhandled('p1')).map((entry) => entry.messageId).sort()).toEqual([
      'msg:1',
      'msg_2'
    ])

    // And the cursor: `advance` needs `has(rawId)`, which is what stuck it before.
    const cursors = new PhotonCursorStore(new PhotonStore(userDataPath))
    expect(
      await cursors.advance('p1', 41, {
        inboxHas: (id) => restarted.has('p1', id),
        messageId: 'msg:1'
      })
    ).toEqual({ advanced: true, seq: 41 })
  })

  it('round-trips a literal percent, so an encoded name cannot be decoded into another id', async () => {
    // `%` is encoded first, so `msg%3A1` (a literal) and `msg:1` stay distinct files *and* distinct ids.
    const first = new PhotonInbox(new PhotonStore(userDataPath))
    await first.claim('p1', message({ id: 'msg%3A1' }), 41)
    await first.claim('p1', message({ id: 'msg:2' }), 47)

    const restarted = new PhotonInbox(new PhotonStore(userDataPath))
    expect((await restarted.ids('p1')).sort()).toEqual(['msg%3A1', 'msg:2'])
    expect((await restarted.read('p1', 'msg%3A1'))?.messageId).toBe('msg%3A1')
    expect((await restarted.read('p1', 'msg:2'))?.messageId).toBe('msg:2')
  })

  it('stores a message id that could escape its directory under a digest', async () => {
    // Refusing the id instead threw out of `claim`, before the handler's park-and-advance path: the
    // stream stopped, the same frame replayed on every resume, and every later message queued behind
    // it. A digest keeps the id (which is what dedupe and the cursor match on) and nothing escapes.
    const inbox = new PhotonInbox(new PhotonStore(userDataPath))

    expect(await inbox.claim('p1', message({ id: '../../etc/passwd' }), 41)).toMatchObject({
      action: 'run'
    })

    const stored = readdirSync(join(userDataPath, 'local-photon', 'inbox', 'p1'))
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatch(/^sha256-[0-9a-f]{64}\.json$/)
    expect((await inbox.read('p1', '../../etc/passwd'))?.messageId).toBe('../../etc/passwd')
    // A second delivery of the same id is the same entry, so it cannot run twice.
    expect(await inbox.claim('p1', message({ id: '../../etc/passwd' }), 42)).toMatchObject({
      action: 'run',
      entry: { seq: 41 }
    })
  })
})

describe('the cursor, which is the handoff checkpoint', () => {
  it('starts at zero, which Photon reads as new events only', async () => {
    expect(await new PhotonCursorStore(new PhotonStore(userDataPath)).read('p1')).toBe(0)
  })

  it('refuses to advance past a message the inbox does not hold', async () => {
    const store = new PhotonStore(userDataPath)
    const cursors = new PhotonCursorStore(store)
    const inbox = new PhotonInbox(store)

    const refused = await cursors.advance('p1', 41, {
      inboxHas: (id) => inbox.has('p1', id),
      messageId: 'msg_1'
    })
    expect(refused).toEqual({ advanced: false, reason: 'not-in-inbox' })
    // The refusal is the assertion: advancing on receipt would be a data-loss bug, and it did not happen.
    expect(await cursors.read('p1')).toBe(0)
  })

  it('advances once the message is in the inbox, and resumes from a gap without assuming +1', async () => {
    const store = new PhotonStore(userDataPath)
    const cursors = new PhotonCursorStore(store)
    const inbox = new PhotonInbox(store)
    await inbox.claim('p1', message({ id: 'msg_41' }))
    await inbox.claim('p1', message({ id: 'msg_47' }))

    expect(
      await cursors.advance('p1', 41, {
        inboxHas: (id) => inbox.has('p1', id),
        messageId: 'msg_41'
      })
    ).toEqual({ advanced: true, seq: 41 })
    // 42..46 never arrived, and nothing invents them: the next cursor is the one Photon named.
    expect(
      await cursors.advance('p1', 47, {
        inboxHas: (id) => inbox.has('p1', id),
        messageId: 'msg_47'
      })
    ).toEqual({ advanced: true, seq: 47 })
    expect(await cursors.read('p1')).toBe(47)
    expect((await cursors.read('p1')) + 1).toBe(48)
  })

  it('never moves backwards, because a rewind is a bug rather than a re-read', async () => {
    const store = new PhotonStore(userDataPath)
    const cursors = new PhotonCursorStore(store)
    const inbox = new PhotonInbox(store)
    await inbox.claim('p1', message({ id: 'msg_41' }))
    await inbox.claim('p1', message({ id: 'msg_47' }))
    await cursors.advance('p1', 47, { inboxHas: (id) => inbox.has('p1', id), messageId: 'msg_47' })

    expect(
      await cursors.advance('p1', 41, {
        inboxHas: (id) => inbox.has('p1', id),
        messageId: 'msg_41'
      })
    ).toEqual({ advanced: false, reason: 'behind-stored-cursor', stored: 47 })
    expect(await cursors.read('p1')).toBe(47)
  })

  it('keeps one cursor per project and per consumer purpose', async () => {
    const store = new PhotonStore(userDataPath)
    const cursors = new PhotonCursorStore(store)
    const inbox = new PhotonInbox(store)
    await inbox.claim('p1', message({ id: 'msg_41' }))
    await cursors.advance('p1', 41, { inboxHas: (id) => inbox.has('p1', id), messageId: 'msg_41' })

    expect(await cursors.read('p1', 'another-integration')).toBe(0)
    expect(await cursors.read('p2')).toBe(0)
  })
})

describe('the thread map', () => {
  it('continues one chat for one conversation and starts another for a new one', async () => {
    const store = new PhotonStore(userDataPath)
    const threads = new PhotonThreadMap(store)
    await threads.bind('b1', 'conv_1', { chatId: 'chat_1', handle: '+15551230000' })

    expect(await threads.chatIdFor('b1', 'conv_1')).toBe('chat_1')
    expect(await threads.chatIdFor('b1', 'conv_2')).toBeNull()
    expect(await threads.knows('b1', 'conv_2')).toBe(false)
  })

  it('survives a restart, so a mid-conversation restart continues rather than restarting', async () => {
    const store = new PhotonStore(userDataPath)
    await new PhotonThreadMap(store).bind('b1', 'conv_1', {
      chatId: 'chat_1',
      handle: '+15551230000'
    })

    expect(await new PhotonThreadMap(new PhotonStore(userDataPath)).chatIdFor('b1', 'conv_1')).toBe(
      'chat_1'
    )
  })

  it('reports a different pool line for the same conversation without losing the chat', async () => {
    const threads = new PhotonThreadMap(new PhotonStore(userDataPath))
    await threads.bind('b1', 'conv_1', {
      chatId: 'chat_1',
      handle: '+15551230000',
      phoneNumber: '+15550101'
    })
    await threads.bind('b1', 'conv_1', {
      chatId: 'chat_1',
      handle: '+15551230000',
      phoneNumber: '+15550202'
    })

    expect(await threads.thread('b1', 'conv_1')).toMatchObject({
      chatId: 'chat_1',
      phoneNumber: '+15550202'
    })
  })
})

describe('the outbox', () => {
  it('keeps a failed send and retries it rather than letting the result vanish', async () => {
    const outbox = new PhotonOutbox(new PhotonStore(userDataPath))
    await outbox.enqueue({
      id: 's1',
      botId: 'b1',
      projectId: 'p1',
      conversationId: 'c1',
      body: 'done'
    })

    await outbox.fail('s1', 'socket hang up')
    expect(await outbox.pendingFor('b1')).toEqual([
      expect.objectContaining({ id: 's1', attempts: 1, lastError: 'socket hang up' })
    ])

    await outbox.settle('s1')
    expect(await outbox.pendingFor('b1')).toEqual([])
  })

  it('does not enqueue the same send twice', async () => {
    const outbox = new PhotonOutbox(new PhotonStore(userDataPath))
    await outbox.enqueue({
      id: 's1',
      botId: 'b1',
      projectId: 'p1',
      conversationId: 'c1',
      body: 'done'
    })
    await outbox.enqueue({
      id: 's1',
      botId: 'b1',
      projectId: 'p1',
      conversationId: 'c1',
      body: 'done'
    })
    expect(await outbox.entries()).toHaveLength(1)
  })

  it('keeps retrying inside the horizon, however many attempts that is', async () => {
    // The horizon is time, not a count: a count is only honest if something tries often enough to reach
    // it, and twelve attempts over a 60 s tick was a quarter of an hour.
    let clock = 1_000
    const outbox = new PhotonOutbox(new PhotonStore(userDataPath), () => clock)
    await outbox.enqueue({
      id: 's1',
      botId: 'b1',
      projectId: 'p1',
      conversationId: 'c1',
      body: 'done'
    })
    for (let attempt = 0; attempt < 50; attempt += 1) {
      clock += 60_000
      expect(await outbox.fail('s1', 'still failing')).toMatchObject({ kind: 'kept' })
    }
    expect(await outbox.entries()).toHaveLength(1)
  })

  it('reports nothing when the entry was already settled or forgotten, which is not the same as dropped', async () => {
    // `retryPending` runs from every tick as `void`, so it can overlap a live `sendTurnResult`. A `null`
    // for both "the horizon passed" and "the entry is gone" told the owner someone was owed a reply that
    // one of the two attempts had in fact delivered.
    let clock = 1_000
    const outbox = new PhotonOutbox(new PhotonStore(userDataPath), () => clock)
    await outbox.enqueue({
      id: 's1',
      botId: 'b1',
      projectId: 'p1',
      conversationId: 'c1',
      body: 'the build is green'
    })
    // A concurrent attempt delivered it.
    await outbox.settle('s1')
    clock += PHOTON_OUTBOX_HORIZON_MS

    expect(await outbox.fail('s1', 'still failing')).toEqual({ kind: 'gone' })
    expect(await outbox.entries()).toEqual([])
  })

  it('gives up when the horizon passes, and says that is what happened', async () => {
    let clock = 1_000
    const outbox = new PhotonOutbox(new PhotonStore(userDataPath), () => clock)
    await outbox.enqueue({
      id: 's1',
      botId: 'b1',
      projectId: 'p1',
      conversationId: 'c1',
      body: 'the build is green'
    })
    await outbox.fail('s1', 'still failing')
    clock += PHOTON_OUTBOX_HORIZON_MS

    const dropped = await outbox.fail('s1', 'still failing')
    expect(dropped).toMatchObject({ kind: 'dropped' })
    // Out of the retry queue for good, and nothing about it left behind to grow with the bot's history:
    // the count and reason live on the record, which is what the status shows.
    expect(await outbox.entries()).toEqual([])
    expect(await outbox.fail('s1', 'still failing')).toEqual({ kind: 'gone' })
  })
})
