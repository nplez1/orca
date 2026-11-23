// The channel's public surface: connect once, create a bot, add and release a member, let a bot go, and
// the two things that happen on their own — a stream that follows each bot's project, and a reply at the
// end of a finished turn. Everything here is guarded by a stored credential, so with nothing connected
// it does nothing at all rather than starting streams it cannot authenticate.
import type { PhotonApi, PhotonCredential } from './photon-api'
import { PhotonApiError } from './photon-api'
import { PHOTON_STREAM_URL } from './photon-contract'
import type { PhotonCursorStore } from './photon-cursor'
import type { PhotonInbound, PhotonPerson } from './photon-inbound'
import { normalisePhotonHandle } from './photon-inbound'
import type { PhotonInbox } from './photon-inbox'
import type { PhotonOutbox } from './photon-outbox'
import type { PhotonProvisioner, ProvisionOutcome } from './photon-provisioning'
import type { PhotonSendOutcome, PhotonSendPath } from './photon-send'
import { PhotonStream, type PhotonIoFactory, type PhotonStreamStatus } from './photon-stream'
import type { PhotonStore } from './photon-store'
import type {
  PhotonTeardown,
  PhotonProjectDeletionOutcome,
  PhotonReleaseOutcome
} from './photon-teardown'
import type { PhotonThreadMap } from './photon-thread-map'
import { photonTurnResultText } from './photon-turn-result'

export type PhotonServiceDeps = {
  store: PhotonStore
  api: PhotonApi
  inbox: PhotonInbox
  cursors: PhotonCursorStore
  threads: PhotonThreadMap
  outbox: PhotonOutbox
  provisioner: PhotonProvisioner
  teardown: PhotonTeardown
  inbound: PhotonInbound
  sendPath: PhotonSendPath
  /** Builds the socket; injected so a test drives the stream without a network. */
  io: PhotonIoFactory
  streamUrl?: string
  log?: (message: string, ...rest: unknown[]) => void
}

export type PhotonConnectResult = {
  organizationId: string
  /** Whether the account key was kept, which is the owner's choice and not a default. */
  stored: boolean
  message: string
}

export type PhotonMemberResult = { handle: string; phoneNumber: string; assignmentId: string }

export class PhotonService {
  private readonly streams = new Map<string, PhotonStream>()
  private readonly log: (message: string, ...rest: unknown[]) => void

  constructor(private readonly deps: PhotonServiceDeps) {
    this.log = deps.log ?? ((message, ...rest) => console.warn(message, ...rest))
  }

  /** Connect once: the account service key, its organization, and the owner's choice about keeping it. */
  connect(input: {
    organizationId: string
    accountKey: string
    /** Off by default. Storing it is what makes every later bot a button instead of a paste. */
    storesKey: boolean
  }): PhotonConnectResult {
    this.deps.store.saveAccount(
      { organizationId: input.organizationId, storesKey: input.storesKey },
      input.accountKey
    )
    return {
      organizationId: input.organizationId,
      stored: input.storesKey,
      message: input.storesKey
        ? 'Photon is connected and the account key is stored, so new bots need no further pasting.'
        : 'Photon is connected for this session. The account key was not stored, so a new bot will ask for it again.'
    }
  }

  /** Create a bot's project, mint its key, give it a number. Retryable end to end. */
  async createBot(input: {
    botId: string
    botName: string
    handle: string
  }): Promise<ProvisionOutcome> {
    const account = this.requireAccount()
    const outcome = await this.deps.provisioner.provision({
      botId: input.botId,
      botName: input.botName,
      handle: input.handle,
      account
    })
    this.startStream(input.botId)
    return outcome
  }

  /** Add someone by creating their assignment — the same call that gives them the number. */
  async addMember(input: { botId: string; handle: string }): Promise<PhotonMemberResult> {
    const record = this.requireRecord(input.botId)
    const credential = this.requireProjectCredential(input.botId)
    const assignment = await this.deps.api.createAssignment({
      credential,
      projectId: record.projectId,
      handle: input.handle,
      idempotencyKey: this.deps.api.idempotencyKey()
    })
    const assignments = [
      ...record.assignments.filter(
        (entry) => normalisePhotonHandle(entry.handle) !== normalisePhotonHandle(assignment.handle)
      ),
      {
        assignmentId: assignment.id,
        handle: assignment.handle,
        phoneNumber: assignment.assignedPhoneNumber
      }
    ]
    this.deps.store.putBot({ ...record, assignments })
    return {
      handle: assignment.handle,
      phoneNumber: assignment.assignedPhoneNumber,
      assignmentId: assignment.id
    }
  }

  /** Remove someone by releasing their number. Reversible: adding them again gives it back. */
  async releaseMember(input: { botId: string; handle: string }): Promise<{ released: boolean }> {
    const record = this.requireRecord(input.botId)
    const wanted = normalisePhotonHandle(input.handle)
    const assignment = record.assignments.find(
      (entry) => normalisePhotonHandle(entry.handle) === wanted
    )
    if (!assignment) {
      return { released: false }
    }
    const credential =
      this.deps.store.projectCredential(input.botId) ?? this.requireAccount().credential
    try {
      await this.deps.api.releaseAssignment(credential, record.projectId, assignment.assignmentId)
    } catch (error) {
      if (!(error instanceof PhotonApiError && error.isMissing)) {
        throw error
      }
    }
    this.deps.store.putBot({
      ...record,
      assignments: record.assignments.filter(
        (entry) => entry.assignmentId !== assignment.assignmentId
      )
    })
    return { released: true }
  }

  /** Deleting a bot releases its numbers and revokes its key. It never deletes the Photon project. */
  async deleteBot(botId: string): Promise<PhotonReleaseOutcome> {
    this.stopStream(botId)
    const outcome = await this.deps.teardown.releaseBot({
      botId,
      account: this.requireAccount().credential
    })
    this.deps.outbox.forget(botId)
    return outcome
  }

  /** The one irreversible step, behind an explicit confirmation naming the slug that will be burned. */
  async deleteProject(input: {
    botId: string
    confirmSlug: string
  }): Promise<PhotonProjectDeletionOutcome> {
    this.stopStream(input.botId)
    const outcome = await this.deps.teardown.deleteProject({
      botId: input.botId,
      account: this.requireAccount().credential,
      confirmSlug: input.confirmSlug
    })
    this.deps.outbox.forget(input.botId)
    return outcome
  }

  /** Reads a half-finished saga back and finishes the record, which is what a crash leaves behind. */
  async reconcile(botId: string): Promise<{ repaired: boolean; notes: string[] }> {
    const account = this.requireAccount()
    const ownerHandle = this.deps.store.bot(botId)?.ownerHandle
    const outcome = await this.deps.provisioner.reconcile({
      botId,
      account,
      ...(ownerHandle ? { handle: ownerHandle } : {})
    })
    return { repaired: outcome.repaired, notes: outcome.notes }
  }

  /** The bot's people, derived from its assignment list so there is no second ACL to keep in step. */
  people(botId: string): Map<string, PhotonPerson> {
    const record = this.deps.store.bot(botId)
    const people = new Map<string, PhotonPerson>()
    for (const assignment of record?.assignments ?? []) {
      const handle = normalisePhotonHandle(assignment.handle)
      const owner = record?.ownerHandle
        ? normalisePhotonHandle(record.ownerHandle) === handle
        : false
      people.set(handle, { name: assignment.handle, role: owner ? 'owner' : 'member' })
    }
    return people
  }

  /** What `orca bot connectors` says about one bot's channel, or null when it has no project. */
  statusFor(botId: string): { phoneNumber: string | null; handles: string[] } | null {
    const record = this.deps.store.bot(botId)
    if (!record) {
      return null
    }
    return {
      phoneNumber: record.phoneNumber ?? null,
      handles: record.assignments.map((entry) => entry.handle)
    }
  }

  /** Follows every bot that has a key. A bot with no project is skipped rather than failing loudly. */
  startStreams(): void {
    for (const record of this.deps.store.bots()) {
      this.startStream(record.botId)
    }
  }

  startStream(botId: string): PhotonStreamStatus | null {
    if (this.streams.has(botId)) {
      return this.streamStatus(botId)
    }
    const record = this.deps.store.bot(botId)
    const credential = this.deps.store.projectCredential(botId)
    if (!record || !credential) {
      return null
    }
    const stream = new PhotonStream({
      io: this.deps.io,
      url: this.deps.streamUrl ?? PHOTON_STREAM_URL,
      projectId: record.projectId,
      credential: credential.key,
      // Read fresh on every subscribe, so a reconnect resumes after what Orca checkpointed.
      readCursor: () => this.deps.cursors.read(record.projectId),
      onFrame: (frame) =>
        this.deps.inbound
          .handle({ botId, projectId: record.projectId, seq: frame.seq, message: frame.message })
          .then(() => undefined),
      log: this.log
    })
    try {
      stream.start()
    } catch (error) {
      // A stream that will not open is not a provisioning failure: the project, its key and its number
      // are already real, and reporting the bot as created is the truthful answer.
      this.log('[photon] could not open a stream for a bot', error)
      return null
    }
    this.streams.set(botId, stream)
    return stream.status()
  }

  stopStream(botId: string): void {
    this.streams.get(botId)?.stop()
    this.streams.delete(botId)
  }

  stopStreams(): void {
    for (const botId of this.streams.keys()) {
      this.stopStream(botId)
    }
  }

  streamStatus(botId: string): PhotonStreamStatus | null {
    return this.streams.get(botId)?.status() ?? null
  }

  /** One send per finished turn, to the conversation that asked. */
  async sendTurnResult(input: {
    botId: string
    botName?: string
    conversationId: string
    text: string
  }): Promise<PhotonSendOutcome> {
    const record = this.requireRecord(input.botId)
    return this.deps.sendPath.sendTurnResult({
      botId: input.botId,
      projectId: record.projectId,
      conversationId: input.conversationId,
      credential: this.requireProjectCredential(input.botId),
      text: input.text,
      ...(input.botName ? { botName: input.botName } : {})
    })
  }

  /** Sends a finished chat turn's answer to the conversation that asked, if this chat is one this
   *  channel opened. Silent otherwise: a bot's ordinary chats post nowhere. */
  async sendChatTurnResult(input: {
    botId: string
    botName?: string
    chatId: string
    rows: Parameters<typeof photonTurnResultText>[0]
  }): Promise<PhotonSendOutcome | null> {
    const conversationId = this.deps.threads.conversationFor(input.botId, input.chatId)
    if (!conversationId) {
      return null
    }
    const text = photonTurnResultText(input.rows)
    if (!text) {
      return null
    }
    return this.sendTurnResult({
      botId: input.botId,
      conversationId,
      text,
      ...(input.botName ? { botName: input.botName } : {})
    })
  }

  async retryPending(botId: string): Promise<PhotonSendOutcome[]> {
    return this.deps.sendPath.retryPending(botId, this.requireProjectCredential(botId))
  }

  private requireAccount(): { organizationId: string; credential: PhotonCredential } {
    const account = this.deps.store.account()
    const credential = this.deps.store.accountCredential()
    if (!account || !credential) {
      throw new Error(
        'Photon is not connected: add the account service key and its organization first, then try again.'
      )
    }
    return { organizationId: account.organizationId, credential }
  }

  private requireRecord(botId: string): NonNullable<ReturnType<PhotonStore['bot']>> {
    const record = this.deps.store.bot(botId)
    if (!record) {
      throw new Error(`This bot has no Photon project yet; create one first.`)
    }
    return record
  }

  private requireProjectCredential(botId: string): PhotonCredential {
    const credential = this.deps.store.projectCredential(botId)
    if (!credential) {
      throw new Error(
        `This bot's Photon project key is missing. Mint a replacement from its Photon project; the old one cannot be read back.`
      )
    }
    return credential
  }
}
