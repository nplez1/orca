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

/** A project id claimed for one bot, or the bot that already reads it. */
export type PhotonSpectrumClaim =
  | { claimed: true; record: PhotonBotRecord }
  | { claimed: false; holderBotId: string }

/**
 * Writes a Spectrum bot's record, but only when no other bot already reads that project.
 *
 * The check and the write are one entry in the store's queue, so two connects racing the same project
 * cannot both find it free and then both write: that would leave two sockets on one inbox, and each bot
 * answering the other's messages. `store.changeRecord` is the queue; the rule lives here.
 */
export function claimPhotonSpectrumProject(
  store: PhotonStore,
  input: PhotonBotRecordInput
): Promise<PhotonSpectrumClaim> {
  const saved = withPhotonBotDefaults({ ...input, mode: 'spectrum' })
  const outcome: { holderBotId: string | null } = { holderBotId: null }
  return store
    .changeRecord((record) => {
      const held = record.bots.find(
        (entry) =>
          entry.mode === 'spectrum' &&
          entry.projectId === saved.projectId &&
          entry.botId !== saved.botId
      )
      if (held) {
        outcome.holderBotId = held.botId
        return null
      }
      return {
        ...record,
        bots: [...record.bots.filter((entry) => entry.botId !== saved.botId), saved]
      }
    })
    .then(() =>
      outcome.holderBotId
        ? { claimed: false, holderBotId: outcome.holderBotId }
        : { claimed: true, record: saved }
    )
}

/**
 * Connects a bot to a Spectrum project the owner already has: the project id from its dashboard and the
 * project's own secret. Nothing is created — the project, its lines and who may reach them are the
 * owner's — so this proves the pair, keeps the secret sealed and the record minimal, and starts reading.
 *
 * Refusals before anything is written, because each would otherwise leave a channel that fails later on
 * its own: a secret asked to be kept where it could only be written base64, a bot whose Orca-provisioned
 * project is still live, a project another bot already reads, and a bot whose channel is *reading* one
 * project being pointed at another. A secret the owner chose not to keep still works for this session,
 * which is what makes "off" a choice rather than broken.
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
  const existing = await deps.store.bot(input.botId)
  // A released account record keeps the project id its deletion has to burn, and nothing of it is live:
  // pointing this bot at a spectrum project is then exactly what a bot with no channel does.
  if (existing && existing.mode === 'account' && !existing.released) {
    throw new Error(
      `This bot already answers on an Orca-provisioned Photon project (${existing.projectId}). Release that channel first, then connect this project.`
    )
  }
  // The probe runs before anything is written: a pair that does not work leaves no record and no secret
  // behind, so a typo is a refusal rather than a channel that fails later.
  const probe = deps.probeSpectrum ?? probePhotonSpectrumProject
  const project = await probe({
    projectId: input.projectId,
    projectSecret: input.projectSecret
  })
  const repointing =
    existing?.mode === 'spectrum' && existing.projectId !== project.projectId ? existing : null
  if (repointing && deps.spectrum.running(input.botId)) {
    throw new Error(
      `This bot is reading Spectrum project ${repointing.projectId} right now, so it cannot be pointed at ${project.projectId} without releasing this channel first. Release it with bots.photon.bot.release, then connect the other project.`
    )
  }
  // The holder check and the write are one store queue entry: two connects racing the same project cannot
  // both find it free and then both open a socket on the one inbox.
  const claimed = await claimPhotonSpectrumProject(deps.store, {
    mode: 'spectrum',
    botId: input.botId,
    projectId: project.projectId,
    ...(project.slug ? { slug: project.slug } : {}),
    ...(existing ? { createdAt: existing.createdAt } : {})
  })
  if (!claimed.claimed) {
    throw new Error(
      `Spectrum project ${project.projectId} is already connected to bot ${claimed.holderBotId}. One project has one inbox, so two bots on it would answer each other's messages; connect this bot to a different project.`
    )
  }
  // Before the new channel opens, the old one closes: a rotated secret or a changed project would
  // otherwise leave the bot reading with the credential it just replaced. Answers queued for a *different*
  // project can never be delivered on this one, so they are settled rather than retried until the horizon
  // passes; a rotated secret keeps them, because they are still addressable.
  deps.spectrum.stop(input.botId)
  if (repointing) {
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
 * Lets go of a bot's channel on the owner's own project: nothing of theirs is released, because Orca
 * created nothing and minted nothing. The channel stops reading and the sealed secret is forgotten, which
 * is all Orca holds. Null when this bot answers on an Orca-provisioned project, whose release is the
 * account path's own.
 */
export async function releasePhotonSpectrumChannel(
  deps: Pick<PhotonCredentialModesDeps, 'store' | 'spectrum' | 'spectrumSecrets' | 'outbox'>,
  botId: string
): Promise<PhotonReleaseOutcome | null> {
  const held = await deps.store.bot(botId)
  if (held?.mode !== 'spectrum') {
    return null
  }
  deps.spectrum.stop(botId)
  await deps.outbox.forget(botId)
  await deps.spectrumSecrets.forget(botId)
  await deps.store.forgetBot(botId)
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
