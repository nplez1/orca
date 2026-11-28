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
import type { PhotonBotRecord } from './photon-store-schema'

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
  await deps.streams.startAll()
  await deps.spectrum.startAll()
  await replayPhotonPending(deps)
}

/** The health tick for the whole channel: restarts what stopped and retries what is queued, for whichever
 *  credential a bot runs on. */
export async function photonHealthTick(deps: {
  streams: { tick(): Promise<void> }
  spectrum: PhotonSpectrumChannels
}): Promise<void> {
  await deps.streams.tick()
  await deps.spectrum.tick()
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

/**
 * Connects a bot to a Spectrum project the owner already has: the project id from its dashboard and the
 * project's own secret. Nothing is created — the project, its lines and who may reach them are the
 * owner's — so this proves the pair, keeps the secret sealed and the record minimal, and starts reading.
 *
 * Three refusals before anything is written, because each would otherwise leave a channel that fails
 * later on its own: a secret asked to be kept where it could only be written base64, a bot that already
 * answers on an Orca-provisioned project, and a project another bot already reads. A secret the owner
 * chose not to keep still works for this session, which is what makes "off" a choice rather than broken.
 */
export async function connectPhotonSpectrum(
  deps: PhotonCredentialModesDeps,
  input: { botId: string; projectId: string; projectSecret: string; storesSecret: boolean }
): Promise<PhotonSpectrumConnectResult> {
  const log = deps.log ?? ((message: string, ...rest: unknown[]) => console.warn(message, ...rest))
  assertPhotonKeyCanBeStored(input.storesSecret)
  const existing = await deps.store.bot(input.botId)
  if (existing && existing.mode === 'account') {
    // Re-connecting a Spectrum bot is allowed — a rotated secret is pasted the same way — but replacing
    // an account provision is not: that project is real capacity with a minted key and assigned numbers.
    throw new Error(
      `This bot already answers on an Orca-provisioned Photon project (${existing.projectId}). Release that channel first, or connect this project to a bot that has none.`
    )
  }
  // The probe runs before anything is written: a pair that does not work leaves no record and no secret
  // behind, so a typo is a refusal rather than a channel that fails later.
  const probe = deps.probeSpectrum ?? probePhotonSpectrumProject
  const project = await probe({
    projectId: input.projectId,
    projectSecret: input.projectSecret
  })
  const holder = (await deps.store.bots()).find(
    (entry) =>
      entry.mode === 'spectrum' &&
      entry.projectId === project.projectId &&
      entry.botId !== input.botId
  )
  if (holder) {
    throw new Error(
      `Spectrum project ${project.projectId} is already connected to bot ${holder.botId}. One project has one inbox, so two bots on it would answer each other's messages; connect this bot to a different project.`
    )
  }
  await deps.store.putBot({
    mode: 'spectrum',
    botId: input.botId,
    projectId: project.projectId,
    ...(project.slug ? { slug: project.slug } : {}),
    ...(existing ? { createdAt: existing.createdAt } : {})
  })
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
