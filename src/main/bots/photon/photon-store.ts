// The Photon channel's non-secret record and its secrets, in the split the design asks for: what Orca
// knows about a bot's project is ordinary state beside the rest of the bot's files, while the account
// service key and each bot's own project key live in an owner-only file. The account key is opt-in to
// store — a toggle, not a default — because the alternative to storing it is re-pasting it for every
// new bot. No key is ever readable back out of Orca: a lost project key is replaced by minting one and
// revoking the old, which is why there is no "show key" path here at all.
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { writeDurableSecureJsonFile } from '../../../shared/secure-storage/secure-file'
import { isMissingFileError } from '../../runtime/rpc/server/pairing/device-registry-corruption'
import { PHOTON_CONSUMER_PURPOSE } from './photon-contract'

export const PHOTON_DIR = 'local-photon'
const RECORD_FILE = 'photon.json'
const SECRET_FILE = 'photon-secrets.json'

/** One person the bot's project has a number for. The assignment is the allowlist, so this is the
 *  provider's own record mirrored, not a second ACL. */
const PhotonAssignmentRecord = z.object({
  assignmentId: z.string().min(1),
  handle: z.string().min(1),
  phoneNumber: z.string().min(1)
})
export type PhotonAssignmentRecord = z.infer<typeof PhotonAssignmentRecord>

/** How far a bot's provisioning got, so the reconciler knows what to read back and finish. */
export const PHOTON_SAGA_STEPS = ['project', 'key', 'assignment'] as const
export type PhotonSagaStep = (typeof PHOTON_SAGA_STEPS)[number]

const PhotonBotRecord = z.object({
  botId: z.string().min(1),
  projectId: z.string().min(1),
  /** The slug the project was created under. Stored, never re-derived: it is immutable upstream. */
  slug: z.string().min(1),
  organizationId: z.string().min(1),
  /** The last step that finished; absent while the first is still running. */
  completedThrough: z.enum(PHOTON_SAGA_STEPS).optional(),
  /** The key's id, so it can be revoked; the secret is in the owner-only file, never here. */
  keyId: z.string().min(1).optional(),
  /** The number this bot last answered on, as the provider reported it rather than as anyone typed it. */
  phoneNumber: z.string().min(1).optional(),
  /** The owner's handle, so the assignment list can say which entry is the owner without a second
   *  list: the assignments *are* the allowlist. */
  ownerHandle: z.string().min(1).optional(),
  assignments: z.array(PhotonAssignmentRecord).default([]),
  createdAt: z.number()
})
export type PhotonBotRecord = z.infer<typeof PhotonBotRecord>

const PhotonAccount = z.object({
  organizationId: z.string().min(1),
  /** Whether the owner chose to store the account key. Off is the default, so a fresh install keeps
   *  nothing it was not asked to keep. */
  storesKey: z.boolean().default(false)
})

const StoredRecord = z.object({
  account: PhotonAccount.optional(),
  bots: z.array(PhotonBotRecord).default([])
})
type StoredRecord = z.infer<typeof StoredRecord>

const StoredSecrets = z.object({
  accountKey: z.string().min(1).optional(),
  /** Per bot, keyed by bot id: only its own project key, never another bot's. */
  projectKeys: z
    .record(z.string(), z.object({ keyId: z.string().min(1), secret: z.string().min(1) }))
    .default({})
})
type StoredSecrets = z.infer<typeof StoredSecrets>

const emptyRecord = (): StoredRecord => ({ bots: [] })
const emptySecrets = (): StoredSecrets => ({ projectKeys: {} })

export type PhotonAccountSettings = z.infer<typeof PhotonAccount>

/** What a caller may hand back after provisioning: the record fields, minus the ones only this store
 *  sets. Taken from the schema's *input* type, so a caller need not repeat the defaults. */
export type PhotonBotRecordInput = Omit<z.input<typeof PhotonBotRecord>, 'createdAt'> & {
  createdAt?: number
}

export class PhotonStore {
  private record: StoredRecord | null = null
  private secrets: StoredSecrets | null = null

  constructor(private readonly userDataPath: string) {}

  get recordPath(): string {
    return join(this.userDataPath, PHOTON_DIR, RECORD_FILE)
  }

  get secretsPath(): string {
    return join(this.userDataPath, PHOTON_DIR, SECRET_FILE)
  }

  /** Where a bot's cursor lives: per project, and per consumer purpose, so an independent integration
   *  cannot overwrite this one's progress. */
  cursorPath(projectId: string, purpose = PHOTON_CONSUMER_PURPOSE): string {
    return join(this.userDataPath, PHOTON_DIR, 'cursors', projectId, `${purpose}.json`)
  }

  /** One inbound message, written before any turn starts: the crash guard and the dedupe index. */
  inboxPath(projectId: string, messageId: string): string {
    return join(this.userDataPath, PHOTON_DIR, 'inbox', projectId, `${messageId}.json`)
  }

  inboxDir(projectId: string): string {
    return join(this.userDataPath, PHOTON_DIR, 'inbox', projectId)
  }

  /** A conversation id mapped to the bot chat that answers it. */
  threadPath(botId: string): string {
    return join(this.userDataPath, PHOTON_DIR, 'threads', `${botId}.json`)
  }

  /** Outbound messages that have not landed yet. */
  outboxPath(): string {
    return join(this.userDataPath, PHOTON_DIR, 'photon-outbox.json')
  }

  /** Reads the record once; every reader after that is served from memory. A file this build cannot
   *  read is reported rather than silently replaced, because losing it would orphan a live project. */
  load(): void {
    this.record ??= this.readRecord()
    this.secrets ??= this.readSecrets()
  }

  private readRecord(): StoredRecord {
    const parsed = StoredRecord.safeParse(readJsonOrNull(this.recordPath))
    if (!parsed.success) {
      console.warn(
        '[photon] the record is unreadable; keeping the file and starting empty',
        parsed.error.issues
      )
      return emptyRecord()
    }
    return parsed.data
  }

  private readSecrets(): StoredSecrets {
    const parsed = StoredSecrets.safeParse(readJsonOrNull(this.secretsPath))
    return parsed.success ? parsed.data : emptySecrets()
  }

  account(): PhotonAccountSettings | null {
    this.load()
    return this.record?.account ?? null
  }

  /** Stores the account settings, and the key itself only when the owner opted in. Turning the toggle
   *  off removes a key that was already stored rather than leaving it behind. */
  saveAccount(settings: PhotonAccountSettings, accountKey: string | undefined): void {
    this.load()
    this.record = { ...(this.record ?? emptyRecord()), account: settings }
    this.secrets = { ...(this.secrets ?? emptySecrets()) }
    if (settings.storesKey && accountKey) {
      this.secrets.accountKey = accountKey
    } else {
      delete this.secrets.accountKey
    }
    this.write()
  }

  /** The stored account key, or null when the owner chose not to keep one. */
  accountKey(): string | null {
    this.load()
    return this.secrets?.accountKey ?? null
  }

  bots(): PhotonBotRecord[] {
    this.load()
    return this.record?.bots ?? []
  }

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
      createdAt: input.createdAt ?? Date.now()
    }
    const bots = (this.record?.bots ?? []).filter((entry) => entry.botId !== saved.botId)
    this.record = { ...(this.record ?? emptyRecord()), bots: [...bots, saved] }
    this.write()
    return saved
  }

  /** Drops a bot's record and its own project key. The Photon project itself is untouched: deleting
   *  the project is a separate, explicitly confirmed cleanup. */
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
    return this.secrets?.projectKeys[botId] ?? null
  }

  putProjectKey(botId: string, key: { keyId: string; secret: string }): void {
    this.load()
    const secrets = this.secrets ?? emptySecrets()
    this.secrets = {
      ...secrets,
      projectKeys: { ...secrets.projectKeys, [botId]: key }
    }
    this.write()
  }

  /** The owner's account key as a call takes it, or null when none is stored. */
  accountCredential(): { kind: 'account'; key: string } | null {
    const key = this.accountKey()
    return key ? { kind: 'account', key } : null
  }

  projectCredential(botId: string): { kind: 'project'; key: string } | null {
    const stored = this.projectKey(botId)
    return stored ? { kind: 'project', key: stored.secret } : null
  }

  private write(): void {
    mkdirSync(dirname(this.recordPath), { recursive: true, mode: 0o700 })
    // Durable, because a record that vanished would orphan a live project the user paid capacity for.
    writeDurableSecureJsonFile(this.recordPath, this.record ?? emptyRecord())
    writeDurableSecureJsonFile(this.secretsPath, this.secrets ?? emptySecrets())
  }
}

/** Removes a bot's inbox directory, for a bot whose project is gone for good. */
export function clearPhotonInbox(store: PhotonStore, projectId: string): void {
  rmSync(store.inboxDir(projectId), { recursive: true, force: true })
}

function readJsonOrNull(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch (error) {
    if (isMissingFileError(error)) {
      return null
    }
    console.warn('[photon] could not read', path, error)
    return null
  }
}
