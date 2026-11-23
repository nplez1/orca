// What each call needs before it does anything: the account key, a bot's record, its own project key.
// Split from the service so the four refusals read as one place, and so the surface is about behaviour.
import type { PhotonCredential } from './photon-api'
import type { PhotonStore } from './photon-store'
import type { PhotonBotRecord } from './photon-store-schema'

/** The account service key and its organization, or a refusal that says what to do about it. */
export function requirePhotonAccount(store: PhotonStore): {
  organizationId: string
  credential: PhotonCredential
} {
  const account = store.account()
  const credential = store.accountCredential()
  if (!account || !credential) {
    throw new Error(
      'Photon is not connected: pass the account service key and its organization to `bots.photon.connect` (or to `bots.photon.create`), then try again.'
    )
  }
  return { organizationId: account.organizationId, credential }
}

export function requirePhotonRecord(store: PhotonStore, botId: string): PhotonBotRecord {
  const record = store.bot(botId)
  if (!record) {
    throw new Error(`This bot has no Photon project yet; create one first.`)
  }
  return record
}

export function requirePhotonLiveRecord(store: PhotonStore, botId: string): PhotonBotRecord {
  const record = requirePhotonRecord(store, botId)
  if (record.released) {
    throw new Error(
      `This bot's Photon channel was released. Re-create it, or delete its project with bots.photon.project.delete.`
    )
  }
  return record
}

export function requirePhotonProjectCredential(
  store: PhotonStore,
  botId: string
): PhotonCredential {
  const credential = store.projectCredential(botId)
  if (!credential) {
    throw new Error(
      `This bot's Photon project key is missing from this computer, so it cannot read its stream or send. Re-mint it in the Photon project and paste it, or re-run bots.photon.create to mint a replacement.`
    )
  }
  return credential
}
