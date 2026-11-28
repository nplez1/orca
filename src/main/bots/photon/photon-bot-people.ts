// The bot's people, derived from its assignment list so there is no second ACL to keep in step. Split from
// the service because it is a read of one record rather than a change to one, and because both the
// inbound handler and anything that lists a channel's people want the same answer.
import { normalisePhotonHandle, type PhotonPerson } from './photon-inbound'
import type { PhotonStore } from './photon-store'

/**
 * Who may text this bot, keyed by the handle they text from. The assignments *are* the allowlist, so a
 * bot with none — one answering on the owner's own Spectrum project — has nobody here, and its inbound
 * path supplies its own default person instead.
 */
export async function photonBotPeople(
  store: PhotonStore,
  botId: string
): Promise<Map<string, PhotonPerson>> {
  const record = await store.bot(botId)
  const people = new Map<string, PhotonPerson>()
  for (const assignment of record?.assignments ?? []) {
    const handle = normalisePhotonHandle(assignment.handle)
    const owner = record?.ownerHandle ? normalisePhotonHandle(record.ownerHandle) === handle : false
    people.set(handle, { name: assignment.handle, role: owner ? 'owner' : 'member' })
  }
  return people
}
