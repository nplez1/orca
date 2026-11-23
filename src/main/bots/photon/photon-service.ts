// The channel's public surface: connect once, create a bot, add and release a member, let a bot go, and
// the two things that happen on their own — a stream that follows each bot's project, and a reply at the
// end of a finished turn. Nothing here needs a stored key: a key handed over for one call is held in
// memory for the session, so the opt-in toggle is a convenience rather than a prerequisite. A bot whose
// record says `released` is a tombstone — its numbers and key are gone, and the only thing left to do
// with it is delete the project — so it starts no stream and answers no messages.
import type { PhotonApi } from './photon-api'
import { PhotonApiError } from './photon-api'
import type { PhotonCursorStore } from './photon-cursor'
import type { PhotonInbound, PhotonPerson } from './photon-inbound'
import { normalisePhotonHandle } from './photon-inbound'
import type { PhotonInbox } from './photon-inbox'
import type { PhotonOutbox } from './photon-outbox'
import type { PhotonProvisioner, ProvisionOutcome } from './photon-provisioning'
import type { PhotonSendOutcome, PhotonSendPath } from './photon-send'
import {
  requirePhotonAccount,
  requirePhotonLiveRecord,
  requirePhotonProjectCredential,
  requirePhotonRecord
} from './photon-credentials'
import type { PhotonStreamStatus } from './photon-stream'
import type { PhotonStreams } from './photon-streams'
import { photonCanSealSecrets as photonSeals } from './photon-secrets'
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
  /** The streams and the tick that keeps them honest. */
  streams: PhotonStreams
}

export type PhotonConnectResult = {
  organizationId: string
  /** Whether the account key was kept, which is the owner's choice and not a default. */
  stored: boolean
  /** Whether this host can seal a key it keeps; a `false` here is why storing is offered rather than
   *  assumed. */
  sealed: boolean
  message: string
}

export type PhotonMemberResult = { handle: string; phoneNumber: string; assignmentId: string }

export class PhotonService {
  private readonly log: (message: string, ...rest: unknown[]) => void

  constructor(private readonly deps: PhotonServiceDeps) {
    this.log = (message, ...rest) => console.warn(message, ...rest)
  }

  /** Connect once: the account service key, its organization, and the owner's choice about keeping it.
   *  The key works for this session either way — a toggle that had to be on before anything ran would
   *  make "off" mean "broken". */
  async connect(input: {
    organizationId: string
    accountKey: string
    storesKey: boolean
  }): Promise<PhotonConnectResult> {
    await this.deps.store.saveAccount(
      { organizationId: input.organizationId, storesKey: input.storesKey },
      input.accountKey
    )
    return {
      organizationId: input.organizationId,
      stored: input.storesKey,
      sealed: photonSeals(),
      message: input.storesKey
        ? 'Photon is connected and the account key is stored, so new bots need no further pasting.'
        : 'Photon is connected for this session only. The account key was not stored, so Orca will ask for it again after a restart.'
    }
  }

  /** Takes the account key for one call without storing anything, which is how a client that did not
   *  connect this session still creates a bot. */
  holdAccountKey(accountKey: string): void {
    this.deps.store.holdAccountKeyForSession(accountKey)
  }

  /** Create a bot's project, mint its key, give it a number. Retryable end to end. */
  async createBot(input: {
    botId: string
    botName: string
    handle: string
    /** A key pasted for this call. Held for the session, never written unless the owner opted in. */
    accountKey?: string
  }): Promise<ProvisionOutcome> {
    if (input.accountKey) {
      this.holdAccountKey(input.accountKey)
    }
    const account = await requirePhotonAccount(this.deps.store)
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
    const record = await requirePhotonLiveRecord(this.deps.store, input.botId)
    const credential = await requirePhotonProjectCredential(this.deps.store, input.botId)
    const assignment = await this.deps.provisioner.assign({
      botId: input.botId,
      projectId: record.projectId,
      handle: input.handle,
      credential
    })
    // Merged inside the store's queue, not onto the record read before the network call: two `member.add`
    // calls in flight each write back a list they read, and one assignment is then lost from the local
    // mirror — after which that member's texts are dropped as unknown senders and nothing can recover
    // them.
    await this.deps.store.updateBot(input.botId, (current) => ({
      ...current,
      assignments: [
        ...current.assignments.filter(
          (entry) =>
            normalisePhotonHandle(entry.handle) !== normalisePhotonHandle(assignment.handle)
        ),
        {
          assignmentId: assignment.assignmentId,
          handle: assignment.handle,
          phoneNumber: assignment.phoneNumber
        }
      ]
    }))
    return {
      handle: assignment.handle,
      phoneNumber: assignment.phoneNumber,
      assignmentId: assignment.assignmentId
    }
  }

  /** Remove someone by releasing their number. Reversible: adding them again gives it back. */
  async releaseMember(input: { botId: string; handle: string }): Promise<{ released: boolean }> {
    const record = await requirePhotonLiveRecord(this.deps.store, input.botId)
    const wanted = normalisePhotonHandle(input.handle)
    const assignment = record.assignments.find(
      (entry) => normalisePhotonHandle(entry.handle) === wanted
    )
    if (!assignment) {
      return { released: false }
    }
    const credential =
      (await this.deps.store.projectCredential(input.botId)) ??
      (await requirePhotonAccount(this.deps.store)).credential
    try {
      await this.deps.api.releaseAssignment(credential, record.projectId, assignment.assignmentId)
    } catch (error) {
      if (!(error instanceof PhotonApiError && error.isMissing)) {
        throw error
      }
    }
    await this.deps.store.updateBot(input.botId, (current) => ({
      ...current,
      assignments: current.assignments.filter(
        (entry) => entry.assignmentId !== assignment.assignmentId
      )
    }))
    return { released: true }
  }

  /** Deleting a bot releases its numbers and revokes its key. It never deletes the Photon project. */
  async deleteBot(botId: string): Promise<PhotonReleaseOutcome> {
    // Recorded as released before anything can fail, so a half-finished teardown is retried by the
    // health tick instead of leaving a live stream on a bot that no longer exists.
    // Inside the queue: a `member.add` in flight would otherwise write its stale record back with
    // `released: false` and leave a live channel on a bot that no longer exists.
    await this.deps.store.updateBot(botId, (current) =>
      current.released ? null : { ...current, released: true, releasedAt: Date.now() }
    )
    this.stopStream(botId)
    return this.deps.teardown.releaseBot({
      botId,
      account: (await requirePhotonAccount(this.deps.store)).credential
    })
  }

  /** The one irreversible step, behind an explicit confirmation naming the slug that will be burned. */
  async deleteProject(input: {
    botId: string
    confirmSlug: string
  }): Promise<PhotonProjectDeletionOutcome> {
    // Validated before the stream is touched: a typo in the slug or a missing account key must not
    // leave the bot deaf until the next restart.
    const record = await requirePhotonRecord(this.deps.store, input.botId)
    if (input.confirmSlug !== record.slug) {
      throw new Error(
        `Refusing to delete project ${record.projectId}: the confirmation names "${input.confirmSlug}" but its slug is "${record.slug}", and the slug can never be reused.`
      )
    }
    const account = (await requirePhotonAccount(this.deps.store)).credential
    this.stopStream(input.botId)
    const outcome = await this.deps.teardown.deleteProject({
      botId: input.botId,
      account,
      confirmSlug: input.confirmSlug
    })
    await this.deps.outbox.forget(input.botId)
    return outcome
  }

  /** Reads a half-finished saga back and finishes the record, which is what a crash leaves behind. Also
   *  the repair for a bot whose mirror of the provider's allowlist went stale. */
  async reconcile(botId: string): Promise<{ repaired: boolean; notes: string[] }> {
    const account = await requirePhotonAccount(this.deps.store)
    const ownerHandle = (await this.deps.store.bot(botId))?.ownerHandle
    const outcome = await this.deps.provisioner.reconcile({
      botId,
      account,
      ...(ownerHandle ? { handle: ownerHandle } : {})
    })
    return { repaired: outcome.repaired, notes: outcome.notes }
  }

  /** This service's own store, which is the one that holds a session key never written to disk. */
  store(): PhotonStore {
    return this.deps.store
  }

  /** The bot's people, derived from its assignment list so there is no second ACL to keep in step. */
  async people(botId: string): Promise<Map<string, PhotonPerson>> {
    const record = await this.deps.store.bot(botId)
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

  /** What `orca bot connectors` says about one bot's channel, or null when the channel has no complete
   *  number for it. A bot provisioned only through its project and key is not connected: it has no
   *  number, so nobody can text it. */
  async statusFor(
    botId: string
  ): Promise<{ phoneNumber: string | null; handles: string[] } | null> {
    const record = await this.deps.store.bot(botId)
    if (!record || record.released || record.completedThrough !== 'assignment') {
      return null
    }
    return {
      phoneNumber: record.phoneNumber ?? null,
      handles: record.assignments.map((entry) => entry.handle)
    }
  }

  /** Whether this bot has a channel at all, which is what a bot delete checks before releasing one. */
  async hasChannel(botId: string): Promise<boolean> {
    const record = await this.deps.store.bot(botId)
    return record !== null && (!record.released || record.assignments.length > 0)
  }

  /** Whether this chat is one the channel answers: the check a turn end makes before reading a journal. */
  async answersChat(botId: string, chatId: string): Promise<boolean> {
    return (await this.deps.threads.conversationFor(botId, chatId)) !== null
  }

  /** Follows every bot that has a key and has not been released, and replays what Orca never dealt with. */
  startStreams(): void {
    void this.deps.streams.startAll().then(() => this.replayPending())
  }

  /** Replays what Orca wrote down and never dealt with, for every live bot: the crash recovery the inbox
   *  exists for, run at startup because that is when a crash is discovered. */
  private async replayPending(): Promise<void> {
    for (const record of await this.deps.store.bots()) {
      await this.replayBot(record.botId)
    }
  }

  /** Replays a live bot's unhandled messages; a released one has none to replay. */
  private async replayBot(botId: string): Promise<void> {
    const record = await this.deps.store.bot(botId)
    if (record && !record.released) {
      this.replay(botId, record.projectId)
    }
  }

  /** Replays one bot's held messages, for a bot that has just been resumed from a pause. */
  async releaseHeld(botId: string): Promise<void> {
    await this.replayBot(botId)
  }

  /** Fire-and-forget on purpose: a caller that provisioned a bot should not wait on its socket. */
  startStream(botId: string): void {
    void this.deps.streams.start(botId)
  }

  stopStream(botId: string): void {
    this.deps.streams.stop(botId)
  }

  streamStatus(botId: string): PhotonStreamStatus | null {
    return this.deps.streams.status(botId)
  }

  /** The health tick: restarts a deaf stream and retries a queued send. */
  healthTick(): Promise<void> {
    return this.deps.streams.tick()
  }

  private replay(botId: string, projectId: string): void {
    void this.deps.inbound
      .recover({ botId, projectId })
      .catch((error: unknown) => this.log('[photon] could not replay held messages', error))
  }

  /** One send per finished turn, to the conversation that asked. */
  async sendTurnResult(input: {
    botId: string
    conversationId: string
    text: string
    turnId: string
  }): Promise<PhotonSendOutcome> {
    const record = await requirePhotonLiveRecord(this.deps.store, input.botId)
    return this.deps.sendPath.sendTurnResult({
      botId: input.botId,
      projectId: record.projectId,
      conversationId: input.conversationId,
      credential: await requirePhotonProjectCredential(this.deps.store, input.botId),
      text: input.text,
      turnId: input.turnId
    })
  }

  /** Sends a finished chat turn's answer to the conversation that asked, if this chat is one this
   *  channel opened. Silent otherwise: a bot's ordinary chats post nowhere. */
  async sendChatTurnResult(input: {
    botId: string
    chatId: string
    turnId: string
    rows: Parameters<typeof photonTurnResultText>[0]
  }): Promise<PhotonSendOutcome | null> {
    const conversationId = await this.deps.threads.conversationFor(input.botId, input.chatId)
    if (!conversationId) {
      return null
    }
    const text = photonTurnResultText(input.rows, input.turnId)
    if (!text) {
      return null
    }
    return this.sendTurnResult({
      botId: input.botId,
      conversationId,
      text,
      turnId: input.turnId
    })
  }

  /** Retries everything waiting for one bot. Called by the health tick and by an explicit request. */
  async retryPending(botId: string): Promise<PhotonSendOutcome[]> {
    return this.deps.sendPath.retryPending(
      botId,
      await requirePhotonProjectCredential(this.deps.store, botId)
    )
  }
}
