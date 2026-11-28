// Which credential a bot's channel runs on, and the work that changes with it: connecting the owner's own
// Spectrum project, letting it go, the credential a send authenticates with, and the startup both kinds
// share. Split from `photon-service.ts` so that file keeps reading as one flow with a mode branch rather
// than two interleaved, and so nothing in the account path had to move to make room.
import type { PhotonCredential } from './photon-api'
import {
  assertPhotonProvisionedProject,
  requirePhotonProjectCredential
} from './photon-credentials'
import { replayPhotonPending, type PhotonInboxReplayDeps } from './photon-inbox-replay'
import type { PhotonOutbox } from './photon-outbox'
import type { PhotonReleaseOutcome } from './photon-teardown'
import { probePhotonSpectrumProject, type PhotonSpectrumProject } from './photon-spectrum-project'
import type { PhotonSpectrumChannels } from './photon-spectrum-channels'
import { assertPhotonKeyCanBeStored, photonCanSealSecrets as photonSeals } from './photon-secrets'
import type { PhotonSpectrumSecrets } from './photon-spectrum-secrets'
import type { PhotonStore } from './photon-store'
import {
  withPhotonBotDefaults,
  type PhotonBotRecord,
  type PhotonBotRecordInput
} from './photon-store-schema'

/** What connecting an existing Spectrum project reports: which project, and where its secret went. */
export type PhotonSpectrumConnectResult = {
  botId: string
  projectId: string
  /** The project's own slug, which is what a listing names it by. Null when Spectrum answered without. */
  slug: string | null
  /** Whether the secret was kept, which is the owner's choice and not a default. */
  stored: boolean
  /** Whether this host can seal a secret it is asked to keep. */
  sealed: boolean
  message: string
}

/** What starting every channel needs, whichever credential a bot runs on: both kinds of stream, and the
 *  inbox replay that follows them. */
export type PhotonChannelStartupDeps = PhotonInboxReplayDeps & {
  streams: { startAll(): Promise<void> }
  spectrum: PhotonSpectrumChannels
}

/** Starts every bot's channel and replays what Orca never dealt with. A Spectrum project's channel is a
 *  stream too, so both kinds start here rather than one of them being a special case at the caller. */
export async function startPhotonChannels(deps: PhotonChannelStartupDeps): Promise<void> {
  const log = deps.log ?? ((message: string, ...rest: unknown[]) => console.warn(message, ...rest))
  await deps.streams.startAll()
  // Not awaited: one Spectrum SDK start-up that hangs is one bot's channel, while the replay below is
  // every bot's mail — including the account-mode bots whose sockets are already open. The registry logs
  // what failed and the health tick starts it again.
  void deps.spectrum
    .startAll()
    .catch((error: unknown) => log('[photon] could not start a Spectrum channel', error))
  await replayPhotonPending(deps)
}

/**
 * Refuses to provision an Orca project for a bot that answers on the owner's own: provisioning writes an
 * account-mode record over the bot's, and a live project of theirs would then be described by a record
 * that no longer names it.
 */
export async function assertPhotonBotHasNoSpectrumChannel(
  deps: Pick<PhotonCredentialModesDeps, 'store'>,
  botId: string
): Promise<void> {
  const held = await deps.store.bot(botId)
  if (held) {
    assertPhotonProvisionedProject(held)
  }
}

export type PhotonSpectrumProjectProbe = (input: {
  projectId: string
  projectSecret: string
}) => Promise<PhotonSpectrumProject>

/** The stores and channel a Spectrum bot needs. `PhotonServiceDeps` satisfies this by construction. */
export type PhotonCredentialModesDeps = {
  store: PhotonStore
  spectrum: PhotonSpectrumChannels
  spectrumSecrets: PhotonSpectrumSecrets
  outbox: PhotonOutbox
  /** Injected so a test proves the refusal paths without a network; production reads the project. */
  probeSpectrum?: PhotonSpectrumProjectProbe
  log?: (message: string, ...rest: unknown[]) => void
}

/** A project id claimed for one bot, or why the bot cannot be pointed at it. */
export type PhotonSpectrumClaim =
  | {
      claimed: true
      record: PhotonBotRecord
      /** The project this bot was reading before, when it is a different one. */
      repointedFrom: string | null
    }
  | { claimed: false; refusal: PhotonSpectrumRefusal }

/** Why a bot cannot be pointed at a Spectrum project. Each carries what the message needs to say what to
 *  do about it. */
export type PhotonSpectrumRefusal =
  | { reason: 'account'; projectId: string }
  | {
      reason: 'unsettled'
      projectId: string
      slug: string | null
      assignments: number
      keyUnrevoked: boolean
    }
  | { reason: 'repointing'; projectId: string; wanted: string }
  | { reason: 'held'; projectId: string; holderBotId: string }

/**
 * Why this bot cannot be claimed for a Spectrum project, read from the record the write is about to
 * replace. A released account record is kept as the prior provision on the new one — it is what
 * `project.delete` names — but only once nothing of that channel is left on it: a number still assigned
 * or a key nobody revoked is a half-finished teardown, and overwriting the record would lose both.
 */
function spectrumRefusal(input: {
  current: PhotonBotRecord | null
  bots: readonly PhotonBotRecord[]
  projectId: string
  botId: string
  reading: boolean
}): PhotonSpectrumRefusal | null {
  const { current } = input
  if (current?.mode === 'account') {
    if (!current.released) {
      return { reason: 'account', projectId: current.projectId }
    }
    if (current.assignments.length > 0 || current.keyId !== undefined) {
      return {
        reason: 'unsettled',
        projectId: current.projectId,
        slug: current.slug ?? null,
        assignments: current.assignments.length,
        keyUnrevoked: current.keyId !== undefined
      }
    }
  }
  if (current?.mode === 'spectrum' && current.projectId !== input.projectId && input.reading) {
    return { reason: 'repointing', projectId: current.projectId, wanted: input.projectId }
  }
  const held = input.bots.find(
    (entry) =>
      entry.mode === 'spectrum' &&
      entry.projectId === input.projectId &&
      entry.botId !== input.botId
  )
  return held ? { reason: 'held', projectId: input.projectId, holderBotId: held.botId } : null
}

/** The refusal as the owner reads it: what is in the way, and the call that clears it. */
function spectrumRefusalMessage(refusal: PhotonSpectrumRefusal): string {
  switch (refusal.reason) {
    case 'account':
      return `This bot already answers on an Orca-provisioned Photon project (${refusal.projectId}). Release that channel first, then connect this project.`
    case 'unsettled': {
      const left = [
        refusal.assignments > 0
          ? `${refusal.assignments} number${refusal.assignments === 1 ? '' : 's'} still assigned`
          : null,
        refusal.keyUnrevoked ? 'an unrevoked project key' : null
      ]
        .filter((part) => part !== null)
        .join(' and ')
      return `This bot's Photon project ${refusal.slug ?? refusal.projectId} was released, but its teardown never finished: ${left}. Run bots.photon.bot.release again to finish it, or delete the project with bots.photon.project.delete, then connect this project — the record being replaced here is what names that project, so overwriting it would strand it.`
    }
    case 'repointing':
      return `This bot is reading Spectrum project ${refusal.projectId} right now, so it cannot be pointed at ${refusal.wanted} without releasing this channel first. Release it with bots.photon.bot.release, then connect the other project.`
    case 'held':
      return `Spectrum project ${refusal.projectId} is already connected to bot ${refusal.holderBotId}. One project has one inbox, so two bots on it would answer each other's messages; connect this bot to a different project.`
  }
}

/**
 * Writes a Spectrum bot's record, unless the bot cannot be pointed there or no other bot already reads
 * that project.
 *
 * The rules and the write are one entry in the store's queue, so two connects racing the same project
 * cannot both find it free and then both write — two sockets on one inbox, each bot answering the
 * other's messages — and a check made before the network probe cannot be overwritten by a concurrent
 * `bots.photon.create` on the same bot. `store.changeRecord` is the queue; the rules live here.
 */
export function claimPhotonSpectrumProject(
  store: PhotonStore,
  input: PhotonBotRecordInput,
  options: { reading: boolean }
): Promise<PhotonSpectrumClaim> {
  const outcome: {
    refusal: PhotonSpectrumRefusal | null
    record: PhotonBotRecord | null
    repointedFrom: string | null
  } = { refusal: null, record: null, repointedFrom: null }
  return store
    .changeRecord((record) => {
      const current = record.bots.find((entry) => entry.botId === input.botId) ?? null
      const priorProvision = priorProvisionOf(current)
      const saved = withPhotonBotDefaults({
        ...input,
        mode: 'spectrum',
        // The record's own age is carried over, so a bot does not look newly created for being re-pointed.
        ...(current ? { createdAt: current.createdAt } : {}),
        ...(priorProvision ? { priorProvision } : {})
      })
      const refusal = spectrumRefusal({
        current,
        bots: record.bots,
        projectId: saved.projectId,
        botId: saved.botId,
        reading: options.reading
      })
      if (refusal) {
        outcome.refusal = refusal
        return null
      }
      outcome.record = saved
      outcome.repointedFrom =
        current?.mode === 'spectrum' && current.projectId !== saved.projectId
          ? current.projectId
          : null
      return {
        ...record,
        bots: [...record.bots.filter((entry) => entry.botId !== saved.botId), saved]
      }
    })
    .then((): PhotonSpectrumClaim => {
      if (outcome.refusal) {
        return { claimed: false, refusal: outcome.refusal }
      }
      if (!outcome.record) {
        // The queue ran the rule and it left the record alone without a refusal to report: nothing was
        // written, so this is not a claim.
        throw new Error('The Spectrum project was not claimed and nothing says why.')
      }
      return {
        claimed: true,
        record: outcome.record,
        repointedFrom: outcome.repointedFrom
      }
    })
}

/** The provisioned project to keep on the new record: this bot's own released one, or whatever an earlier
 *  switch already kept — a second connect must not forget the project the first one made reachable. */
function priorProvisionOf(current: PhotonBotRecord | null): PhotonBotRecord['priorProvision'] {
  if (current?.mode === 'account') {
    return {
      projectId: current.projectId,
      ...(current.slug ? { slug: current.slug } : {})
    }
  }
  return current?.priorProvision
}

/**
 * Connects a bot to a Spectrum project the owner already has: the project id from its dashboard and the
 * project's own secret. Nothing is created — the project, its lines and who may reach them are the
 * owner's — so this proves the pair, keeps the secret sealed and the record minimal, and starts reading.
 *
 * Refusals before anything is written, because each would otherwise leave a channel that fails later on
 * its own: a secret asked to be kept where it could only be written base64, a bot whose Orca-provisioned
 * project is still live (or whose teardown never finished), a project another bot already reads, and a bot
 * whose channel is *reading* one project being pointed at another. A secret the owner chose not to keep
 * still works for this session, which is what makes "off" a choice rather than broken.
 *
 * Re-connecting the same project is how a rotated secret is applied, so it is allowed and it takes
 * effect: the channel reading the old secret is closed before the new one opens.
 */
export async function connectPhotonSpectrum(
  deps: PhotonCredentialModesDeps,
  input: { botId: string; projectId: string; projectSecret: string; storesSecret: boolean }
): Promise<PhotonSpectrumConnectResult> {
  const log = deps.log ?? ((message: string, ...rest: unknown[]) => console.warn(message, ...rest))
  assertPhotonKeyCanBeStored(input.storesSecret)
  // The probe runs before anything is written: a pair that does not work leaves no record and no secret
  // behind, so a typo is a refusal rather than a channel that fails later.
  const probe = deps.probeSpectrum ?? probePhotonSpectrumProject
  const project = await probe({
    projectId: input.projectId,
    projectSecret: input.projectSecret
  })
  // Every other refusal reads the record *inside* the store's queue, with the write: the pair is proven
  // over the network, and a `bots.photon.create` racing that window would otherwise be overwritten by
  // this claim — or a record already replaced by it would be checked as it was before the probe.
  const claimed = await claimPhotonSpectrumProject(
    deps.store,
    {
      mode: 'spectrum',
      botId: input.botId,
      projectId: project.projectId,
      ...(project.slug ? { slug: project.slug } : {})
    },
    { reading: deps.spectrum.running(input.botId) }
  )
  if (!claimed.claimed) {
    throw new Error(spectrumRefusalMessage(claimed.refusal))
  }
  // Before the new channel opens, the old one closes: a rotated secret or a changed project would
  // otherwise leave the bot reading with the credential it just replaced. Answers queued for a *different*
  // project can never be delivered on this one, so they are settled rather than retried until the horizon
  // passes; a rotated secret keeps them, because they are still addressable.
  deps.spectrum.stop(input.botId)
  if (claimed.repointedFrom) {
    await deps.outbox.forget(input.botId)
  }
  const secret = { projectId: project.projectId, secret: input.projectSecret }
  if (input.storesSecret) {
    await deps.spectrumSecrets.put(input.botId, secret)
  } else {
    deps.spectrumSecrets.holdForSession(input.botId, secret)
  }
  // Fire-and-forget, as a provisioned bot's stream is: the pair is already proven, so a connect should not
  // wait on a long-lived client opening.
  void deps.spectrum
    .start(input.botId)
    .catch((error: unknown) => log('[photon] could not start a Spectrum stream', error))
  return {
    botId: input.botId,
    projectId: project.projectId,
    slug: project.slug,
    stored: input.storesSecret,
    sealed: photonSeals(),
    message: input.storesSecret
      ? `This bot now answers on the Spectrum project “${project.name}”, and its secret is stored sealed. Its lines, and who may reach them, stay in Spectrum.`
      : `This bot now answers on the Spectrum project “${project.name}” for this session only. The secret was not stored, so Orca will ask for it again after a restart. Its lines, and who may reach them, stay in Spectrum.`
  }
}

/**
/** What letting go of a Spectrum channel needs. The outbox is a slice rather than the class: a release
 *  only ever asks it to forget. */
export type PhotonSpectrumReleaseDeps = {
  store: PhotonStore
  spectrum: PhotonSpectrumChannels
  spectrumSecrets: PhotonSpectrumSecrets
  outbox: { forget(botId: string): Promise<void> }
}

/**
 * Lets go of a bot's channel on the owner's own project: nothing of theirs is released, because Orca
 * created nothing and minted nothing. The channel stops reading and the sealed secret is forgotten, which
 * is all Orca holds. Null when this bot answers on an Orca-provisioned project, whose release is the
 * account path's own.
 */
export async function releasePhotonSpectrumChannel(
  deps: PhotonSpectrumReleaseDeps,
  botId: string
): Promise<PhotonReleaseOutcome | null> {
  const held = await deps.store.bot(botId)
  if (held?.mode !== 'spectrum') {
    return null
  }
  deps.spectrum.stop(botId)
  // The record goes first: a start whose `createApp` resolves after this point re-reads the record, finds
  // it gone and closes its client, where forgetting it last let that start publish a channel for a bot
  // about to be deleted — and the tick only walks records, so nothing would ever stop it.
  await deps.store.forgetBot(botId)
  await deps.outbox.forget(botId)
  await deps.spectrumSecrets.forget(botId)
  return { botId, released: [], revokedKey: false, projectKept: true, problems: [] }
}

/**
 * The credential an HTTP send authenticates with, or none when this bot sends through its own Spectrum
 * channel. Still refuses a missing project key: a bot whose credential is gone is a bot to re-mint one
 * for, not one to fail silently on the next turn.
 */
export async function photonSendCredential(
  deps: Pick<PhotonCredentialModesDeps, 'store'>,
  record: PhotonBotRecord
): Promise<PhotonCredential | undefined> {
  if (record.mode === 'spectrum') {
    return undefined
  }
  return requirePhotonProjectCredential(deps.store, record.botId)
}
