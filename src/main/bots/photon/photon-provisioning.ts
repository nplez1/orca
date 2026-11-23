// Provisioning a bot's Photon project is a saga, because each step can half-succeed: project created
// but key mint failed, key minted but the assignment refused on plan capacity, assignment made but Orca
// died before persisting the number. Every step is idempotent, so the repair is a reconciler that reads
// state back and finishes the record — never a rollback, which would delete a resource that cost the
// user capacity.
//
// The idempotency keys are derived from the bot id rather than stored: a caller-chosen key only has to
// be stable across a retry, and deriving it means a restart resumes the same saga without an intent file
// that could itself be lost. The slug is stored, not re-derived, because it is immutable upstream.
import { createHash } from 'node:crypto'
import type { PhotonApi, PhotonCredential } from './photon-api'
import { PhotonApiError } from './photon-api'
import { photonSlugForBot } from './photon-contract'
import type { PhotonBotRecord, PhotonStore } from './photon-store'

export type PhotonProvisionDeps = {
  api: PhotonApi
  store: PhotonStore
  log?: (message: string, ...rest: unknown[]) => void
}

export type ProvisionInput = {
  botId: string
  botName: string
  /** The owner's handle to give the bot a number for; a phone number, or an Apple-ID email. */
  handle: string
  account: { organizationId: string; credential: PhotonCredential }
}

export type ProvisionOutcome = {
  record: PhotonBotRecord
  /** True when this call created the project, false when it found the one a retry already made. */
  createdProject: boolean
  /** True when a step this call ran had already been done, so the outcome is a replay. */
  replayed: boolean
}

/** Stable across restarts, distinct per bot, so a retried create replays instead of making a second
 *  project that consumes capacity and hands out a second number. */
export function photonCreateKey(botId: string): string {
  return `photon-create-${botId}`
}

export function photonKeyMintKey(botId: string, generation: string): string {
  return `photon-key-${botId}-${generation}`
}

export function photonAssignmentKey(botId: string, handle: string): string {
  const digest = createHash('sha256').update(handle.trim().toLowerCase()).digest('hex').slice(0, 16)
  return `photon-assign-${botId}-${digest}`
}

/** The slug a bot's project is created under, from its stored record when it has one. */
export function photonSlugFor(input: { botName: string; stored?: PhotonBotRecord | null }): string {
  return input.stored?.slug ?? photonSlugForBot(input.botName)
}

export class PhotonProvisioner {
  private readonly log: (message: string, ...rest: unknown[]) => void

  constructor(private readonly deps: PhotonProvisionDeps) {
    this.log = deps.log ?? ((message, ...rest) => console.warn(message, ...rest))
  }

  /**
   * Runs the saga from wherever the record says it stopped, to the end. Safe to call repeatedly: each
   * step asks upstream first and only does work that is missing.
   */
  async provision(input: ProvisionInput): Promise<ProvisionOutcome> {
    const { api, store } = this.deps
    const existing = store.bot(input.botId)
    const slug = photonSlugFor({ botName: input.botName, stored: existing })

    // Step 1 — the project. Its own key is the slug, and the derived idempotency key makes a replay
    // return the project this bot already has.
    let createdProject = false
    let projectId = existing?.projectId
    if (projectId) {
      const read = await api.getProject(input.account.credential, projectId)
      if (!read) {
        this.log('[photon] the record names a project upstream no longer has', projectId)
        projectId = undefined
      }
    }
    if (!projectId) {
      const project = await api.createProject({
        credential: input.account.credential,
        organizationId: input.account.organizationId,
        slug,
        name: input.botName,
        idempotencyKey: photonCreateKey(input.botId)
      })
      projectId = project.id
      createdProject = !existing
      // Persist the project id before anything else can fail, so a crash here resumes rather than
      // creating a second project under a slug that would now be taken.
      store.putBot({
        botId: input.botId,
        projectId,
        slug: project.slug,
        organizationId: input.account.organizationId,
        completedThrough: 'project',
        createdAt: existing?.createdAt
      })
    }

    // Step 2 — the bot's own project key. The secret comes back only here, so a mint whose response
    // was lost cannot be re-read: the repair is a fresh mint with a fresh generation.
    const storedKey = store.projectKey(input.botId)
    let keyId = existing?.keyId
    if (!storedKey || !keyId) {
      const generation = existing?.keyId ? `replace-${Date.now()}` : 'initial'
      const minted = await api.mintProjectKey({
        credential: input.account.credential,
        projectId,
        name: `orca-bot-${input.botId}`,
        idempotencyKey: photonKeyMintKey(input.botId, generation)
      })
      store.putProjectKey(input.botId, { keyId: minted.id, secret: minted.secret })
      keyId = minted.id
      const previous = existing?.keyId
      if (previous && previous !== minted.id) {
        // Losing a key is recoverable: mint a replacement, then revoke the old one.
        await api
          .revokeProjectKey(input.account.credential, projectId, previous)
          .catch((error: unknown) => this.log('[photon] could not revoke the replaced key', error))
      }
    }
    const current = store.bot(input.botId)
    if (!current) {
      throw new Error(`No Photon record was written for bot ${input.botId}.`)
    }
    store.putBot({
      ...current,
      keyId,
      completedThrough: 'key'
    })

    // Step 3 — the number, which is also the allowlist entry.
    const assignment = await this.findOrCreateAssignment(
      input.botId,
      projectId,
      input.handle,
      input.account.credential
    )
    const beforeAssignment = store.bot(input.botId)
    if (!beforeAssignment) {
      throw new Error(`No Photon record was written for bot ${input.botId}.`)
    }
    const record = store.putBot({
      ...beforeAssignment,
      keyId,
      completedThrough: 'assignment',
      ownerHandle: input.handle,
      assignments: [assignment],
      phoneNumber: assignment.phoneNumber
    })
    return { record, createdProject, replayed: !createdProject && existing !== null }
  }

  /**
   * Reads a half-finished saga back from upstream and finishes the record. This is what runs after a
   * crash, and it repairs rather than rolls back: a project that exists keeps existing.
   */
  async reconcile(input: {
    botId: string
    handle?: string
    account: { organizationId: string; credential: PhotonCredential }
  }): Promise<{ repaired: boolean; record: PhotonBotRecord | null; notes: string[] }> {
    const { api, store } = this.deps
    const record = store.bot(input.botId)
    if (!record) {
      return { repaired: false, record: null, notes: ['no record to reconcile'] }
    }
    const notes: string[] = []
    const project = await api.getProject(input.account.credential, record.projectId)
    if (!project) {
      notes.push(`project ${record.projectId} is gone upstream; the record cannot be repaired`)
      return { repaired: false, record, notes }
    }
    let repaired = false
    if (project.slug !== record.slug) {
      // The stored slug is what deletion warns about, so a mismatch is repaired to upstream's truth.
      notes.push(`slug repaired from ${record.slug} to ${project.slug}`)
      repaired = true
    }
    if (!store.projectCredential(input.botId)) {
      notes.push('no project key stored; a replacement is needed before this bot can hear anything')
    }
    let assignments = record.assignments
    if (input.handle) {
      const assignment = await this.findOrCreateAssignment(
        input.botId,
        record.projectId,
        input.handle,
        input.account.credential
      )
      if (!assignments.some((entry) => entry.assignmentId === assignment.assignmentId)) {
        notes.push(`assignment for ${input.handle} repaired`)
        repaired = true
      }
      assignments = [
        ...assignments.filter((entry) => entry.handle !== assignment.handle),
        assignment
      ]
    }
    const repairedRecord = store.putBot({
      ...record,
      slug: project.slug,
      assignments,
      phoneNumber: assignments.at(-1)?.phoneNumber ?? record.phoneNumber,
      completedThrough: assignments.length > 0 ? 'assignment' : record.completedThrough
    })
    return {
      repaired: repaired || repairedRecord.completedThrough !== record.completedThrough,
      record: repairedRecord,
      notes
    }
  }

  /** Asking first is what makes this idempotent without leaning on a replayed idempotency key: a
   *  handle that already has a number keeps it, which is also what a user expects of a re-run. */
  private async findOrCreateAssignment(
    botId: string,
    projectId: string,
    handle: string,
    accountCredential: PhotonCredential
  ): Promise<{ assignmentId: string; handle: string; phoneNumber: string }> {
    const { api, store } = this.deps
    const projectCredential = store.projectCredential(botId) ?? accountCredential
    const wanted = handle.trim().toLowerCase()
    const listed = await api
      .listAssignments(projectCredential, projectId)
      .catch((error: unknown) => {
        this.log('[photon] could not list assignments; creating instead', error)
        return []
      })
    const found = listed.find((entry) => entry.handle.trim().toLowerCase() === wanted)
    if (found) {
      return {
        assignmentId: found.id,
        handle: found.handle,
        phoneNumber: found.assignedPhoneNumber
      }
    }
    try {
      const created = await api.createAssignment({
        credential: projectCredential,
        projectId,
        handle,
        idempotencyKey: photonAssignmentKey(botId, handle)
      })
      return {
        assignmentId: created.id,
        handle: created.handle,
        phoneNumber: created.assignedPhoneNumber
      }
    } catch (error) {
      if (error instanceof PhotonApiError && error.status === 409) {
        // A concurrent attempt won; read the number back rather than failing the saga.
        const reread = await api.listAssignments(projectCredential, projectId)
        const raced = reread.find((entry) => entry.handle.trim().toLowerCase() === wanted)
        if (raced) {
          return {
            assignmentId: raced.id,
            handle: raced.handle,
            phoneNumber: raced.assignedPhoneNumber
          }
        }
      }
      throw error
    }
  }
}
