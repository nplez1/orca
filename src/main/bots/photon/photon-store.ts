// The Photon channel's non-secret record and its secrets, in the split the design asks for: what Orca
// knows about a bot's project is ordinary state beside the rest of the bot's files, while the account
// service key and each bot's own project key are sealed through the host's secret store. The account key
// is opt-in to *persist* — a toggle, not a default — and a key handed over for one call is kept in memory
// for the session so the default path works without storing anything. No key is ever readable back out of
// Orca: a lost project key is replaced by minting one and revoking the old, which is why there is no
// "show key" path here at all.
//
// Every read and write is asynchronous: this store is consulted on each delivery and each turn end, and a
// synchronous read there blocks every window on Electron's main thread.
import { readPhotonJson, removePhotonDir, writePhotonJson } from './photon-files'
import {
  StoredRecord,
  StoredSecrets,
  emptyRecord,
  emptySecrets,
  type PhotonAccountSettings,
  type PhotonBotRecord,
  type PhotonBotRecordInput,
  withPhotonBotDefaults
} from './photon-store-schema'
import {
  photonCursorPath,
  photonInboxDir,
  photonInboxPath,
  photonOutboxPath,
  photonRecordPath,
  photonSecretsPath,
  photonThreadPath
} from './photon-store-paths'
import { sealPhotonSecret, unsealPhotonSecret } from './photon-secrets'

/** What one queued change may touch: the record and the secrets, as the draft it is applied to. */
type StoredDraft = { record: StoredRecord | null; secrets: StoredSecrets | null }

/** A file this store cannot read is never silently replaced: overwriting it would orphan a live project
 *  and erase every key. The caller gets this and decides, rather than the store losing the data. */
export class PhotonStoreUnreadableError extends Error {
  constructor(readonly path: string) {
    super(
      `Orca cannot read ${path}, so it will not overwrite it: that file may name projects and keys that still exist. Move it aside to start over.`
    )
    this.name = 'PhotonStoreUnreadableError'
  }
}

export class PhotonStore {
  private record: StoredRecord | null = null
  private secrets: StoredSecrets | null = null
  private recordUnreadable = false
  private secretsUnreadable = false
  private loading: Promise<void> | null = null
  /** One change at a time, each over the state the one before it left. */
  private queue: Promise<void> = Promise.resolve()
  /** A key handed over for this session only. Never written unless the owner opted in. */
  private sessionAccountKey: string | null = null

  constructor(private readonly userDataPath: string) {}

  get recordPath(): string {
    return photonRecordPath(this.userDataPath)
  }

  get secretsPath(): string {
    return photonSecretsPath(this.userDataPath)
  }

  /** Where a bot's cursor lives: per project, and per consumer purpose, so an independent integration
   *  cannot overwrite this one's progress. */
  cursorPath(projectId: string, purpose?: string): string {
    return photonCursorPath(this.userDataPath, projectId, purpose)
  }

  /** One inbound message, written before any turn starts: the crash guard and the dedupe index. */
  inboxPath(projectId: string, messageId: string): string {
    return photonInboxPath(this.userDataPath, projectId, messageId)
  }

  inboxDir(projectId: string): string {
    return photonInboxDir(this.userDataPath, projectId)
  }

  /** A conversation id mapped to the bot chat that answers it. */
  threadPath(botId: string): string {
    return photonThreadPath(this.userDataPath, botId)
  }

  /** Outbound messages that have not landed yet. */
  outboxPath(): string {
    return photonOutboxPath(this.userDataPath)
  }

  /** Reads both files once; every reader after that is served from memory. A file this build cannot
   *  read is reported rather than silently replaced, because losing it would orphan a live project. */
  async load(): Promise<void> {
    this.loading ??= this.read()
    await this.loading
  }

  private async read(): Promise<void> {
    const record = await this.readRecord()
    this.record = record.value
    this.recordUnreadable = record.unreadable
    const secrets = await this.readSecrets()
    this.secrets = secrets.value
    this.secretsUnreadable = secrets.unreadable
  }

  /** True when a file exists that this build cannot read; every write then refuses rather than
   *  replacing data that may still be live. */
  get unreadable(): { record: boolean; secrets: boolean } {
    return { record: this.recordUnreadable, secrets: this.secretsUnreadable }
  }

  private async readRecord(): Promise<{ value: StoredRecord; unreadable: boolean }> {
    const read = await readPhotonJson(this.recordPath, 'record')
    if (read.kind === 'missing') {
      return { value: emptyRecord(), unreadable: false }
    }
    if (read.kind === 'unreadable') {
      return { value: emptyRecord(), unreadable: true }
    }
    const parsed = StoredRecord.safeParse(read.value)
    if (!parsed.success) {
      // Issues only: a zod issue carries the path and the rule, never the value it refused, so no
      // fragment of a key reaches a log.
      console.warn(
        '[photon] the record is unreadable; keeping the file rather than starting over',
        parsed.error.issues.map((issue) => issue.path.join('.') || 'root')
      )
      return { value: emptyRecord(), unreadable: true }
    }
    return { value: parsed.data, unreadable: false }
  }

  private async readSecrets(): Promise<{ value: StoredSecrets; unreadable: boolean }> {
    const read = await readPhotonJson(this.secretsPath, 'secrets')
    if (read.kind === 'missing') {
      return { value: emptySecrets(), unreadable: false }
    }
    if (read.kind === 'unreadable') {
      return { value: emptySecrets(), unreadable: true }
    }
    const parsed = StoredSecrets.safeParse(read.value)
    if (!parsed.success) {
      console.warn(
        '[photon] the secrets file is unreadable; keeping the file rather than starting over',
        parsed.error.issues.map((issue) => issue.path.join('.') || 'root')
      )
      return { value: emptySecrets(), unreadable: true }
    }
    return { value: parsed.data, unreadable: false }
  }

  async account(): Promise<PhotonAccountSettings | null> {
    await this.load()
    return this.record?.account ?? null
  }

  /** Stores the account settings, and the key itself only when the owner opted in. Turning the toggle
   *  off removes a key that was already stored rather than leaving it behind; the key handed over still
   *  works for this session, because the alternative is a toggle that has to be on for anything to run. */
  saveAccount(settings: PhotonAccountSettings, accountKey: string | undefined): Promise<void> {
    return this.change((draft) => {
      draft.record = { ...(draft.record ?? emptyRecord()), account: settings }
      draft.secrets = { ...(draft.secrets ?? emptySecrets()) }
      if (accountKey !== undefined) {
        this.sessionAccountKey = accountKey
      }
      if (settings.storesKey && accountKey) {
        draft.secrets.accountKey = sealPhotonSecret(accountKey)
      } else {
        delete draft.secrets.accountKey
      }
    })
  }

  /** Keeps a key for this session only: the account stays connected until Orca quits, and nothing about
   *  it is written. This is what makes the default toggle off workable rather than broken. */
  holdAccountKeyForSession(accountKey: string): void {
    this.sessionAccountKey = accountKey
  }

  /** The stored account key, or null when the owner chose not to keep one. */
  async accountKey(): Promise<string | null> {
    await this.load()
    const stored = this.secrets?.accountKey
    if (stored) {
      const opened = unsealPhotonSecret(stored)
      if (opened) {
        return opened
      }
      // A sealed key this host cannot open is the same as no key: a mint is the repair, and the
      // session copy is the fallback.
      console.warn('[photon] the stored account key cannot be opened on this host')
    }
    return this.sessionAccountKey
  }

  async bots(): Promise<PhotonBotRecord[]> {
    await this.load()
    return this.record?.bots ?? []
  }

  /** Every bot with a project, released ones included: a released bot's record is what still names the
   *  project its deletion has to burn. */
  async bot(botId: string): Promise<PhotonBotRecord | null> {
    return (await this.bots()).find((entry) => entry.botId === botId) ?? null
  }

  /** Saves a bot's record. The reconciler calls this with the state it read back, which is how a
   *  half-finished saga finishes instead of rolling back. Parsed on the way in, so every default has one
   *  source: an input the schema refuses throws here rather than being written and read back as damaged. */
  async putBot(input: PhotonBotRecordInput): Promise<PhotonBotRecord> {
    const saved = withPhotonBotDefaults(input)
    await this.change((draft) => {
      const bots = (draft.record?.bots ?? []).filter((entry) => entry.botId !== saved.botId)
      draft.record = { ...(draft.record ?? emptyRecord()), bots: [...bots, saved] }
    })
    return saved
  }

  /** Runs one change over the whole record inside the queue, for a caller whose check and write have to be
   *  one step but whose rule is not this file's to own. Null leaves the record alone. */
  changeRecord(mutate: (record: StoredRecord) => StoredRecord | null): Promise<void> {
    return this.change((draft) => {
      const next = mutate(structuredClone(draft.record ?? emptyRecord()))
      if (next) {
        draft.record = next
      }
    })
  }

  /**
   * Changes one bot's record **inside the queue**, so the read and the write cannot be split by another
   * change to the same bot. A caller that reads with `bot()`, awaits a network call and then calls
   * `putBot()` writes back the record it read — and a concurrent change to the same bot is then gone:
   * two `member.add` calls lose one assignment from the local mirror, and a `member.add` in flight over
   * a `release` writes `released: false` back. `change()` serialises per store, which covers different
   * bots; this covers the same one.
   *
   * `mutate` returns the record to write, or null to leave it alone.
   */
  updateBot(
    botId: string,
    mutate: (record: PhotonBotRecord) => PhotonBotRecord | null
  ): Promise<PhotonBotRecord | null> {
    let saved: PhotonBotRecord | null = null
    const publish = (draft: StoredDraft, next: PhotonBotRecord): void => {
      saved = next
      draft.record = {
        ...(draft.record ?? emptyRecord()),
        bots: (draft.record?.bots ?? []).map((entry) => (entry.botId === next.botId ? next : entry))
      }
    }
    return this.change((draft) => {
      const record = (draft.record?.bots ?? []).find((entry) => entry.botId === botId)
      if (!record) {
        return
      }
      const next = mutate(structuredClone(record))
      if (next) {
        publish(draft, next)
      }
    }).then(() => saved)
  }

  /** Notes that a sender Orca does not have assigned reached the stream, so the mirror is stale. */
  noteUnknownSender(botId: string): Promise<void> {
    return this.updateBot(botId, (record) => ({
      ...record,
      unknownSenderCount: record.unknownSenderCount + 1
    })).then(() => undefined)
  }

  /** Notes that a message could not be delivered and was parked, so the status can say the bot went
   *  quiet for a reason rather than merely going quiet. */
  noteParkedMessage(botId: string, reason: string): Promise<void> {
    return this.updateBot(botId, (record) => ({
      ...record,
      parkedMessageCount: record.parkedMessageCount + 1,
      lastParkedReason: reason.slice(0, 300)
    })).then(() => undefined)
  }

  /** Notes an answer that never arrived, so a listing can say someone is owed a reply rather than
   *  leaving the owner to infer it from silence. */
  noteUndeliveredAnswer(botId: string, reason: string): Promise<void> {
    return this.updateBot(botId, (record) => ({
      ...record,
      undeliveredAnswerCount: record.undeliveredAnswerCount + 1,
      lastUndeliveredReason: reason.slice(0, 300)
    })).then(() => undefined)
  }

  /** Drops one bot's own project key, keeping its record: what a released channel is left with. */
  forgetProjectKey(botId: string): Promise<void> {
    return this.change((draft) => {
      if (!draft.secrets) {
        return
      }
      const { [botId]: _dropped, ...rest } = draft.secrets.projectKeys
      draft.secrets = { ...draft.secrets, projectKeys: rest }
    })
  }

  /**
   * Drops a bot's record and its own project key. The Photon project itself is untouched: deleting the
   * project is a separate, explicitly confirmed cleanup — which is why releasing works by keeping a
   * tombstone, and this is only called once the project is gone or the owner starts over.
   */
  forgetBot(botId: string): Promise<void> {
    return this.change((draft) => {
      draft.record = {
        ...(draft.record ?? emptyRecord()),
        bots: (draft.record?.bots ?? []).filter((entry) => entry.botId !== botId)
      }
      if (draft.secrets) {
        const { [botId]: _dropped, ...rest } = draft.secrets.projectKeys
        draft.secrets = { ...draft.secrets, projectKeys: rest }
      }
    })
  }

  async projectKey(botId: string): Promise<{ keyId: string; secret: string } | null> {
    await this.load()
    const stored = this.secrets?.projectKeys[botId]
    if (!stored) {
      return null
    }
    const opened = unsealPhotonSecret(stored.secret)
    return opened ? { keyId: stored.keyId, secret: opened } : null
  }

  putProjectKey(botId: string, key: { keyId: string; secret: string }): Promise<void> {
    return this.change((draft) => {
      const secrets = draft.secrets ?? emptySecrets()
      draft.secrets = {
        ...secrets,
        projectKeys: {
          ...secrets.projectKeys,
          [botId]: { keyId: key.keyId, secret: sealPhotonSecret(key.secret) }
        }
      }
    })
  }

  /** The owner's account key as a call takes it, or null when none is stored and none is held. */
  async accountCredential(): Promise<{ kind: 'account'; key: string } | null> {
    const key = await this.accountKey()
    return key ? { kind: 'account', key } : null
  }

  async projectCredential(botId: string): Promise<{ kind: 'project'; key: string } | null> {
    const stored = await this.projectKey(botId)
    return stored ? { kind: 'project', key: stored.secret } : null
  }

  /**
   * One change at a time, then one write. A queued change reads the state its predecessor left, so two
   * overlapping writes cannot each clone the same record and lose the other's bot.
   *
   * The change is applied to a **draft** and swapped in only once the write has landed, which is the same
   * shape `photon-thread-map.ts` uses: a reader that arrives mid-write sees the record that is on disk,
   * not a mutation that may yet fail. A failed write therefore publishes nothing and needs no rollback.
   */
  private change(mutate: (draft: StoredDraft) => void): Promise<void> {
    const run = this.queue.then(async () => {
      await this.load()
      // A file that could not be read is never replaced: that would erase the projects and keys it names.
      const unreadable = this.unreadable
      if (unreadable.record) {
        throw new PhotonStoreUnreadableError(this.recordPath)
      }
      if (unreadable.secrets) {
        throw new PhotonStoreUnreadableError(this.secretsPath)
      }
      const draft: StoredDraft = {
        record: structuredClone(this.record),
        secrets: structuredClone(this.secrets)
      }
      mutate(draft)
      // Durable, because a record that vanished would orphan a live project the user paid capacity for.
      // Only what actually changed is rewritten, so a send does not rewrite the whole secrets file.
      const recordChanged = JSON.stringify(draft.record) !== JSON.stringify(this.record)
      const secretsChanged = JSON.stringify(draft.secrets) !== JSON.stringify(this.secrets)
      if (recordChanged) {
        await writePhotonJson(this.recordPath, draft.record ?? emptyRecord())
      }
      if (secretsChanged) {
        await writePhotonJson(this.secretsPath, draft.secrets ?? emptySecrets())
      }
      // Published only now: everything above can still throw, and nothing a reader could have seen has
      // moved if it did.
      if (recordChanged) {
        this.record = draft.record
      }
      if (secretsChanged) {
        this.secrets = draft.secrets
      }
    })
    // The queue outlives a failed write, so one refusal does not wedge every later change.
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}

/** Removes a bot's inbox directory, for a bot whose project is gone for good. */
export async function clearPhotonInbox(store: PhotonStore, projectId: string): Promise<void> {
  await removePhotonDir(store.inboxDir(projectId))
}
