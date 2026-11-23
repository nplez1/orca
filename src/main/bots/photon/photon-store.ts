// The Photon channel's non-secret record and its secrets, in the split the design asks for: what Orca
// knows about a bot's project is ordinary state beside the rest of the bot's files, while the account
// service key and each bot's own project key are sealed through the host's secret store. The account key
// is opt-in to *persist* — a toggle, not a default — and a key handed over for one call is kept in memory
// for the session so the default path works without storing anything. No key is ever readable back out of
// Orca: a lost project key is replaced by minting one and revoking the old, which is why there is no
// "show key" path here at all.
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeDurableSecureJsonFile } from '../../../shared/secure-storage/secure-file'
import { isMissingFileError } from '../../runtime/rpc/server/pairing/device-registry-corruption'
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
import {
  StoredRecord,
  StoredSecrets,
  emptyRecord,
  emptySecrets,
  type PhotonAccountSettings,
  type PhotonBotRecord,
  type PhotonBotRecordInput
} from './photon-store-schema'

/** One person the bot's project has a number for. The assignment is the allowlist, so this is the
 *  provider's own record mirrored, not a second ACL. */
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

  /** Reads the record once; every reader after that is served from memory. A file this build cannot
   *  read is reported rather than silently replaced, because losing it would orphan a live project. */
  load(): void {
    if (this.record === null) {
      const read = this.readRecord()
      this.record = read.value
      this.recordUnreadable = read.unreadable
    }
    if (this.secrets === null) {
      const read = this.readSecrets()
      this.secrets = read.value
      this.secretsUnreadable = read.unreadable
    }
  }

  /** True when a file exists that this build cannot read; every write then refuses rather than
   *  replacing data that may still be live. */
  get unreadable(): { record: boolean; secrets: boolean } {
    this.load()
    return { record: this.recordUnreadable, secrets: this.secretsUnreadable }
  }

  private readRecord(): { value: StoredRecord; unreadable: boolean } {
    const read = readJsonOrNull(this.recordPath, 'record')
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

  private readSecrets(): { value: StoredSecrets; unreadable: boolean } {
    const read = readJsonOrNull(this.secretsPath, 'secrets')
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

  account(): PhotonAccountSettings | null {
    this.load()
    return this.record?.account ?? null
  }

  /** Stores the account settings, and the key itself only when the owner opted in. Turning the toggle
   *  off removes a key that was already stored rather than leaving it behind; the key handed over still
   *  works for this session, because the alternative is a toggle that has to be on for anything to run. */
  saveAccount(settings: PhotonAccountSettings, accountKey: string | undefined): void {
    this.load()
    this.record = { ...(this.record ?? emptyRecord()), account: settings }
    this.secrets = { ...(this.secrets ?? emptySecrets()) }
    if (accountKey !== undefined) {
      this.sessionAccountKey = accountKey
    }
    if (settings.storesKey && accountKey) {
      this.secrets.accountKey = sealPhotonSecret(accountKey)
    } else {
      delete this.secrets.accountKey
    }
    this.write()
  }

  /** Keeps a key for this session only: the account stays connected until Orca quits, and nothing about
   *  it is written. This is what makes the default toggle off workable rather than broken. */
  holdAccountKeyForSession(accountKey: string): void {
    this.sessionAccountKey = accountKey
  }

  /** The stored account key, or null when the owner chose not to keep one. */
  accountKey(): string | null {
    this.load()
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

  bots(): PhotonBotRecord[] {
    this.load()
    return this.record?.bots ?? []
  }

  /** Every bot with a project, released ones included: a released bot's record is what still names the
   *  project its deletion has to burn. */
  bot(botId: string): PhotonBotRecord | null {
    return this.bots().find((entry) => entry.botId === botId) ?? null
  }

  /** Saves a bot's record. The reconciler calls this with the state it read back, which is how a
   *  half-finished saga finishes instead of rolling back. */
  putBot(input: PhotonBotRecordInput): PhotonBotRecord {
    this.load()
    const saved: PhotonBotRecord = {
      ...input,
      assignments: input.assignments ?? [],
      keyGeneration: input.keyGeneration ?? 0,
      released: input.released ?? false,
      unknownSenderCount: input.unknownSenderCount ?? 0,
      createdAt: input.createdAt ?? Date.now()
    }
    const bots = (this.record?.bots ?? []).filter((entry) => entry.botId !== saved.botId)
    this.record = { ...(this.record ?? emptyRecord()), bots: [...bots, saved] }
    this.write()
    return saved
  }

  /** Drops one bot's own project key, keeping its record: what a released channel is left with. */
  forgetProjectKey(botId: string): void {
    this.load()
    if (!this.secrets) {
      return
    }
    const { [botId]: _dropped, ...rest } = this.secrets.projectKeys
    this.secrets = { ...this.secrets, projectKeys: rest }
    this.write()
  }

  /** Notes that a sender Orca does not have assigned reached the stream, so the mirror is stale. */
  noteUnknownSender(botId: string): void {
    const record = this.bot(botId)
    if (!record) {
      return
    }
    this.putBot({ ...record, unknownSenderCount: record.unknownSenderCount + 1 })
  }

  /**
   * Drops a bot's record and its own project key. The Photon project itself is untouched: deleting the
   * project is a separate, explicitly confirmed cleanup — which is why releasing works by keeping a
   * tombstone, and this is only called once the project is gone or the owner starts over.
   */
  forgetBot(botId: string): void {
    this.load()
    this.record = {
      ...(this.record ?? emptyRecord()),
      bots: (this.record?.bots ?? []).filter((entry) => entry.botId !== botId)
    }
    if (this.secrets) {
      const { [botId]: _dropped, ...rest } = this.secrets.projectKeys
      this.secrets = { ...this.secrets, projectKeys: rest }
    }
    this.write()
  }

  projectKey(botId: string): { keyId: string; secret: string } | null {
    this.load()
    const stored = this.secrets?.projectKeys[botId]
    if (!stored) {
      return null
    }
    const opened = unsealPhotonSecret(stored.secret)
    return opened ? { keyId: stored.keyId, secret: opened } : null
  }

  putProjectKey(botId: string, key: { keyId: string; secret: string }): void {
    this.load()
    const secrets = this.secrets ?? emptySecrets()
    this.secrets = {
      ...secrets,
      projectKeys: {
        ...secrets.projectKeys,
        [botId]: { keyId: key.keyId, secret: sealPhotonSecret(key.secret) }
      }
    }
    this.write()
  }

  /** The owner's account key as a call takes it, or null when none is stored and none is held. */
  accountCredential(): { kind: 'account'; key: string } | null {
    const key = this.accountKey()
    return key ? { kind: 'account', key } : null
  }

  projectCredential(botId: string): { kind: 'project'; key: string } | null {
    const stored = this.projectKey(botId)
    return stored ? { kind: 'project', key: stored.secret } : null
  }

  private write(): void {
    this.load()
    // A file that could not be read is never replaced: that would erase the projects and keys it names.
    const unreadable = this.unreadable
    if (unreadable.record) {
      throw new PhotonStoreUnreadableError(this.recordPath)
    }
    if (unreadable.secrets) {
      throw new PhotonStoreUnreadableError(this.secretsPath)
    }
    mkdirSync(dirname(this.recordPath), { recursive: true, mode: 0o700 })
    // Durable, because a record that vanished would orphan a live project the user paid capacity for.
    // `false` means owner-only permissions could not be published, which is reported rather than
    // treated as a failed write: the file is there either way.
    for (const [path, value] of [
      [this.recordPath, this.record ?? emptyRecord()],
      [this.secretsPath, this.secrets ?? emptySecrets()]
    ] as const) {
      if (!writeDurableSecureJsonFile(path, value)) {
        console.warn('[photon] could not publish owner-only permissions for', path)
      }
    }
  }
}

/** Removes a bot's inbox directory, for a bot whose project is gone for good. */
export function clearPhotonInbox(store: PhotonStore, projectId: string): void {
  rmSync(store.inboxDir(projectId), { recursive: true, force: true })
}

/** What is in the file. Three answers, because "absent" and "unreadable" must not be confused: the second
 *  is what stops a write from replacing data that still names live projects and keys. The parse error
 *  itself is never logged — V8 quotes the input in it, which for the secrets file is part of a key. */
type FileRead = { kind: 'missing' } | { kind: 'unreadable' } | { kind: 'parsed'; value: unknown }

function readJsonOrNull(path: string, what: string): FileRead {
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (error) {
    if (!isMissingFileError(error)) {
      console.warn('[photon] could not read the', what, 'file')
      return { kind: 'unreadable' }
    }
    return { kind: 'missing' }
  }
  try {
    return { kind: 'parsed', value: JSON.parse(text) }
  } catch {
    console.warn('[photon] the', what, 'file is not JSON')
    return { kind: 'unreadable' }
  }
}
