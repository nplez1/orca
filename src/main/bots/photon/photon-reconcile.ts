// What a half-finished saga is finished from: the provider's own state, read back. Kept beside the saga
// rather than inside it because its job is the opposite of provisioning's — it believes what upstream
// says and repairs the record to match, including minting the key that can never be read back.
import type { PhotonApi, PhotonCredential } from './photon-api'
import { normalisePhotonHandle as normalise, photonKeyMintKey } from './photon-provisioning-keys'
import type { PhotonStore } from './photon-store'
import type { PhotonAssignmentRecord, PhotonBotRecord } from './photon-store-schema'

export type ReconcileDeps = {
  api: PhotonApi
  store: PhotonStore
  log: (message: string, ...rest: unknown[]) => void
  /** Asking first, then creating: the same call the saga uses, so a repair cannot make a second number. */
  assign: (input: {
    botId: string
    projectId: string
    handle: string
    generation: number
    credential: PhotonCredential
  }) => Promise<{ assignmentId: string; handle: string; phoneNumber: string }>
}

/** Reads the provider's state back and finishes the record. What runs after a crash, and what repairs a
 *  bot whose mirror of the allowlist went stale. */
export async function reconcileRecord(
  deps: ReconcileDeps,
  input: {
    botId: string
    handle?: string
    account: { organizationId: string; credential: PhotonCredential }
  }
): Promise<{ repaired: boolean; record: PhotonBotRecord | null; notes: string[] }> {
  const { api, store } = deps
  const record = await store.bot(input.botId)
  if (!record) {
    return { repaired: false, record: null, notes: ['no record to reconcile'] }
  }
  const notes: string[] = []
  if (record.released) {
    return {
      repaired: false,
      record,
      notes: ['the channel was released; only its project is left']
    }
  }
  const project = await api.getProject(input.account.credential, record.projectId)
  if (!project) {
    notes.push(`project ${record.projectId} is gone upstream; the record cannot be repaired`)
    return { repaired: false, record, notes }
  }
  let repaired = false
  let slug = record.slug
  if (project.slug !== record.slug) {
    // The stored slug is what deletion warns about, so a mismatch is repaired to upstream's truth.
    notes.push(`slug repaired from ${record.slug} to ${project.slug}`)
    slug = project.slug
    repaired = true
  }
  // The key is the one thing that cannot be read back, so a missing one is re-minted rather than
  // merely noted: without it the bot cannot read its stream or send anything.
  let keyId = record.keyId
  let keyGeneration = record.keyGeneration
  if (!(await store.projectCredential(input.botId)) || !keyId) {
    keyGeneration += 1
    const minted = await api.mintProjectKey({
      credential: input.account.credential,
      projectId: record.projectId,
      name: `orca-bot-${input.botId}`,
      idempotencyKey: photonKeyMintKey(input.botId, keyGeneration)
    })
    await store.putProjectKey(input.botId, { keyId: minted.id, secret: minted.secret })
    keyId = minted.id
    notes.push('no project key was stored; minted a replacement')
    repaired = true
  }
  // The provider's assignment list is the allowlist, so the record is rebuilt from it rather than
  // from whichever handle this call happens to name.
  const credential = (await store.projectCredential(input.botId)) ?? input.account.credential
  const listed = await api.listAssignments(credential, record.projectId).catch((error: unknown) => {
    notes.push(`could not list assignments: ${messageOf(error)}`)
    return null
  })
  let assignments = record.assignments
  if (listed !== null) {
    const next = listed.map((entry) => ({
      assignmentId: entry.id,
      handle: entry.handle,
      phoneNumber: entry.assignedPhoneNumber
    }))
    if (JSON.stringify(next) !== JSON.stringify(assignments)) {
      notes.push(`assignments repaired from upstream (${next.length} of them)`)
      repaired = true
    }
    assignments = next
  }
  if (input.handle) {
    const assignment = await deps.assign({
      botId: input.botId,
      projectId: record.projectId,
      handle: input.handle,
      generation: keyGeneration,
      credential
    })
    const merged = mergeAssignment(assignments, assignment)
    if (merged.length !== assignments.length) {
      notes.push(`assignment for the owner repaired`)
      repaired = true
    }
    assignments = merged
  }
  const ownerHandle =
    record.ownerHandle ??
    assignments.find((entry) => normalise(entry.handle) === normalise(input.handle ?? ''))
      ?.handle ??
    assignments[0]?.handle
  // A record is only complete when it has a number: a project and a key with no assignment is a bot
  // nobody can text, and saying otherwise is what made a half-provisioned bot read as connected.
  const completedThrough = assignments.length > 0 ? 'assignment' : 'key'
  const phoneNumber =
    assignments.find((entry) => entry.handle === ownerHandle)?.phoneNumber ??
    assignments[0]?.phoneNumber ??
    record.phoneNumber
  const repairedRecord = await store.putBot({
    ...record,
    slug,
    keyId,
    keyGeneration,
    assignments,
    completedThrough,
    ...(ownerHandle ? { ownerHandle } : {}),
    ...(phoneNumber ? { phoneNumber } : {})
  })
  return {
    repaired: repaired || repairedRecord.completedThrough !== record.completedThrough,
    record: repairedRecord,
    notes
  }
}

/** Adds an assignment to a list, replacing the entry for the same handle, and never dropping another. */
function mergeAssignment(
  assignments: readonly PhotonAssignmentRecord[],
  assignment: { assignmentId: string; handle: string; phoneNumber: string }
): PhotonAssignmentRecord[] {
  return [
    ...assignments.filter((entry) => normalise(entry.handle) !== normalise(assignment.handle)),
    {
      assignmentId: assignment.assignmentId,
      handle: assignment.handle,
      phoneNumber: assignment.phoneNumber
    }
  ]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
