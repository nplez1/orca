// What each call needs before it does anything: the account key, a bot's record, its own project key.
// Split from the service so the four refusals read as one place, and so the surface is about behaviour.
import type { PhotonCredential } from './photon-api'
import type { PhotonSpectrumSecrets } from './photon-spectrum-secrets'
import type { PhotonStore } from './photon-store'
import type { PhotonBotRecord } from './photon-store-schema'

/** The account service key and its organization, or a refusal that says what to do about it. */
export async function requirePhotonAccount(store: PhotonStore): Promise<{
  organizationId: string
  credential: PhotonCredential
}> {
  const account = await store.account()
  const credential = await store.accountCredential()
  if (!account || !credential) {
    throw new Error(
      'Photon is not connected: pass the account service key and its organization to `bots.photon.connect` (or to `bots.photon.create`), then try again.'
    )
  }
  return { organizationId: account.organizationId, credential }
}

export async function requirePhotonRecord(
  store: PhotonStore,
  botId: string
): Promise<PhotonBotRecord> {
  const record = await store.bot(botId)
  if (!record) {
    throw new Error(`This bot has no Photon project yet; create one first.`)
  }
  return record
}

export async function requirePhotonLiveRecord(
  store: PhotonStore,
  botId: string
): Promise<PhotonBotRecord> {
  const record = await requirePhotonRecord(store, botId)
  if (record.released) {
    throw new Error(
      `This bot's Photon channel was released. Re-create it, or delete its project with bots.photon.project.delete.`
    )
  }
  return record
}

/** A live record on an Orca-provisioned project: what an assignment change and a project deletion need,
 *  and the refusal a bot on the owner's own Spectrum project gets instead. */
export async function requirePhotonLiveProvisionedRecord(
  store: PhotonStore,
  botId: string
): Promise<PhotonBotRecord> {
  const record = await requirePhotonLiveRecord(store, botId)
  assertPhotonProvisionedProject(record)
  return record
}

export async function requirePhotonProjectCredential(
  store: PhotonStore,
  botId: string
): Promise<PhotonCredential> {
  const credential = await store.projectCredential(botId)
  if (!credential) {
    throw new Error(
      `This bot's Photon project key is missing from this computer, so it cannot read its stream or send. Re-mint it in the Photon project and paste it, or re-run bots.photon.create to mint a replacement.`
    )
  }
  return credential
}

/** An existing Spectrum project's own pair, from the sealed secret kept beside the record. A secret
 *  written for another project is not this bot's, so it is refused rather than tried. */
export async function requirePhotonSpectrumSecret(
  secrets: PhotonSpectrumSecrets,
  record: PhotonBotRecord
): Promise<{ projectId: string; secret: string }> {
  const stored = await secrets.secret(record.botId)
  if (!stored || stored.projectId !== record.projectId) {
    throw new Error(
      `This bot's Spectrum project secret is missing from this computer, so it cannot read its stream or send. Paste the project secret again with bots.photon.spectrum.connect.`
    )
  }
  return stored
}

/** A bot's record on an Orca-provisioned project: what a project deletion and a reconcile need, since
 *  neither is Orca's to do on the owner's own project. */
export async function requirePhotonProvisionedRecord(
  store: PhotonStore,
  botId: string
): Promise<PhotonBotRecord> {
  const record = await requirePhotonRecord(store, botId)
  assertPhotonProvisionedProject(record)
  return record
}

/**
 * Refuses the work only an Orca-provisioned project has: an assignment list, a minted key, a re-mint, a
 * project deletion. A Spectrum project the owner already had decides all of that in Spectrum's own
 * dashboard — and for a deletion, which is irreversible and burns the slug, Orca has no business trying.
 */
export function assertPhotonProvisionedProject(record: PhotonBotRecord): void {
  if (record.mode === 'spectrum') {
    throw new Error(
      `This bot answers on your own Spectrum project, which Orca did not provision: add people, change its lines and delete it in Spectrum, not in Orca.`
    )
  }
}
