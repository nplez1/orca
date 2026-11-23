// Provisioning a bot's Photon project is a saga, because each step can half-succeed: project created
// but key mint failed, key minted but the assignment refused on plan capacity, assignment made but Orca
// died before persisting the number. Every step is idempotent, so the repair is a reconciler that reads
// state back and finishes the record — never a rollback, which would delete a resource that cost the
// user capacity.
//
// The idempotency keys are derived from the bot id rather than stored: a caller-chosen key only has to
// be stable across a retry, and deriving it means a restart resumes the same saga without an intent file
// that could itself be lost. The slug is stored, not re-derived, because it is immutable upstream — and
// a slug that is already taken is looked up and adopted rather than retried forever, because two bots
// with the same name derive the same slug.
import type { PhotonApi, PhotonCredential } from './photon-api'
import { PhotonApiError } from './photon-api'
import { photonSlugForBot } from './photon-contract'
import { reconcileRecord } from './photon-reconcile'
import {
  normalisePhotonHandle as normalise,
  photonAssignmentKey,
  photonCreateKey,
  photonKeyMintKey
} from './photon-provisioning-keys'
import type { PhotonStore } from './photon-store'
import type { PhotonAssignmentRecord, PhotonBotRecord } from './photon-store-schema'

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

export type PhotonAssignmentResult = {
  assignmentId: string
  handle: string
  phoneNumber: string
}

/** The slug a bot's project is created under: its stored one when it has one, else derived from its name
 *  and its id. Stored, never re-derived for a bot that has a project — the slug is immutable upstream. */
export function photonSlugFor(input: {
  botName: string
  botId: string
  stored?: PhotonBotRecord | null
}): string {
  return input.stored?.slug ?? photonSlugForBot(input.botName, input.botId)
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
    const existing = await store.bot(input.botId)
    if (existing?.released) {
      throw new Error(
        `This bot's Photon channel was released; its project is kept but its numbers are gone. Delete the project first, then create a new channel.`
      )
    }
    const slug = photonSlugFor({ botName: input.botName, botId: input.botId, stored: existing })

    // Step 1 — the project. Its own key is the slug, and the derived idempotency key makes a replay
    // return the project this bot already has.
    let createdProject = false
    let projectId = existing?.projectId
    let storedSlug = existing?.slug ?? slug
    if (projectId) {
      const read = await api.getProject(input.account.credential, projectId)
      if (!read) {
        this.log('[photon] the record names a project upstream no longer has', projectId)
        projectId = undefined
      } else {
        storedSlug = read.slug
      }
    }
    if (!projectId) {
      const project = await this.createOrAdoptProject({
        slug,
        name: input.botName,
        botId: input.botId,
        account: input.account
      })
      projectId = project.id
      storedSlug = project.slug
      createdProject = !existing
      // Persist the project id before anything else can fail, so a crash here resumes rather than
      // creating a second project under a slug that would now be taken.
      await store.putBot({
        botId: input.botId,
        projectId,
        slug: storedSlug,
        organizationId: input.account.organizationId,
        completedThrough: 'project',
        assignments: existing?.assignments ?? [],
        keyGeneration: existing?.keyGeneration ?? 0,
        ...(existing?.ownerHandle ? { ownerHandle: existing.ownerHandle } : {}),
        ...(existing?.phoneNumber ? { phoneNumber: existing.phoneNumber } : {}),
        createdAt: existing?.createdAt
      })
    }

    // Step 2 — the bot's own project key. The secret comes back only here, so a mint whose response
    // was lost cannot be re-read: the repair is a fresh mint in a new generation, and the generation is
    // persisted so the mint's own idempotency key is never reused.
    const storedKey = await store.projectKey(input.botId)
    let keyId = existing?.keyId
    let keyGeneration = existing?.keyGeneration ?? 0
    if (!storedKey || !keyId) {
      keyGeneration = (existing?.keyGeneration ?? 0) + 1
      const minted = await api.mintProjectKey({
        credential: input.account.credential,
        projectId,
        name: `orca-bot-${input.botId}`,
        idempotencyKey: photonKeyMintKey(input.botId, keyGeneration)
      })
      await store.putProjectKey(input.botId, { keyId: minted.id, secret: minted.secret })
      keyId = minted.id
      const previous = existing?.keyId
      if (previous && previous !== minted.id) {
        // Losing a key is recoverable: mint a replacement, then revoke the old one. A revoke that fails
        // is reported in the reconciler's notes rather than only logged.
        try {
          await api.revokeProjectKey(input.account.credential, projectId, previous)
        } catch (error) {
          this.log('[photon] could not revoke the replaced key', error)
        }
      }
    }
    const afterKey = await store.bot(input.botId)
    if (!afterKey) {
      throw new Error(`No Photon record was written for bot ${input.botId}.`)
    }
    await store.putBot({
      ...afterKey,
      keyId,
      keyGeneration,
      completedThrough: 'key'
    })

    // Step 3 — the number, which is also the allowlist entry. Existing members are kept: an assignment
    // list written as `[assignment]` would erase everyone added since, and their texts would then be
    // dropped as unknown senders while still being assigned upstream.
    const assignment = await this.findOrCreateAssignment({
      botId: input.botId,
      projectId,
      handle: input.handle,
      generation: keyGeneration,
      credential: input.account.credential
    })
    const beforeAssignment = await store.bot(input.botId)
    if (!beforeAssignment) {
      throw new Error(`No Photon record was written for bot ${input.botId}.`)
    }
    const record = await store.putBot({
      ...beforeAssignment,
      keyId,
      keyGeneration,
      completedThrough: 'assignment',
      // The provider's normalised handle, not the typed one: `(555) 123-4567` and `+15551234567` are
      // the same assignment, and comparing a typed form against the returned one made the owner a
      // member.
      ownerHandle: assignment.handle,
      assignments: mergeAssignment(beforeAssignment.assignments, assignment),
      phoneNumber: assignment.phoneNumber
    })
    return { record, createdProject, replayed: !createdProject && existing !== null }
  }

  /** Adds someone to the bot's project. The key is derived from the bot and the handle, so a retried
   *  add replays rather than creating a second assignment, and a 409 is read back instead of thrown. */
  async assign(input: {
    botId: string
    projectId: string
    handle: string
    credential: PhotonCredential
    generation?: number
  }): Promise<PhotonAssignmentResult> {
    return this.findOrCreateAssignment({
      botId: input.botId,
      projectId: input.projectId,
      handle: input.handle,
      generation: input.generation ?? (await this.deps.store.bot(input.botId))?.keyGeneration ?? 0,
      credential: input.credential
    })
  }

  /**
   * Reads a half-finished saga back from upstream and finishes the record. This is what runs after a
   * crash, and it repairs rather than rolls back: a project that exists keeps existing. It reads the
   * assignment list too, so the record comes back to matching what the provider actually holds.
   */
  async reconcile(input: {
    botId: string
    handle?: string
    account: { organizationId: string; credential: PhotonCredential }
  }): Promise<{ repaired: boolean; record: PhotonBotRecord | null; notes: string[] }> {
    return reconcileRecord(
      {
        api: this.deps.api,
        store: this.deps.store,
        log: this.log,
        assign: (assignInput) => this.findOrCreateAssignment(assignInput)
      },
      input
    )
  }

  /** Asking first is what makes this idempotent without leaning on a replayed idempotency key: a
   *  handle that already has a number keeps it, which is also what a user expects of a re-run. */
  private async findOrCreateAssignment(input: {
    botId: string
    projectId: string
    handle: string
    generation: number
    credential: PhotonCredential
  }): Promise<PhotonAssignmentResult> {
    const { api, store } = this.deps
    const credential = (await store.projectCredential(input.botId)) ?? input.credential
    const wanted = normalise(input.handle)
    const listed = await api
      .listAssignments(credential, input.projectId)
      .catch((error: unknown) => {
        this.log('[photon] could not list assignments; creating instead', error)
        return []
      })
    const found = listed.find((entry) => normalise(entry.handle) === wanted)
    if (found) {
      return {
        assignmentId: found.id,
        handle: found.handle,
        phoneNumber: found.assignedPhoneNumber
      }
    }
    try {
      const created = await api.createAssignment({
        credential,
        projectId: input.projectId,
        handle: input.handle,
        idempotencyKey: photonAssignmentKey(input.botId, input.generation, input.handle)
      })
      return {
        assignmentId: created.id,
        handle: created.handle,
        phoneNumber: created.assignedPhoneNumber
      }
    } catch (error) {
      if (error instanceof PhotonApiError && error.status === 409) {
        // A concurrent attempt won, or the key expired and the assignment already exists; either way
        // the number is real and reading it back is the answer.
        const reread = await api.listAssignments(credential, input.projectId)
        const raced = reread.find((entry) => normalise(entry.handle) === wanted)
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

  /** Creates the project, or adopts the one already holding this slug. A 409 is a slug or an
   *  idempotency key this bot already used, and both mean "read it back", not "fail forever". */
  private async createOrAdoptProject(input: {
    slug: string
    name: string
    botId: string
    account: { organizationId: string; credential: PhotonCredential }
  }): Promise<{ id: string; slug: string }> {
    try {
      const project = await this.deps.api.createProject({
        credential: input.account.credential,
        organizationId: input.account.organizationId,
        slug: input.slug,
        name: input.name,
        idempotencyKey: photonCreateKey(input.botId)
      })
      return { id: project.id, slug: project.slug }
    } catch (error) {
      if (!(error instanceof PhotonApiError) || error.status !== 409) {
        throw error
      }
      const adopted = await this.deps.api.findProjectBySlug(
        input.account.credential,
        input.account.organizationId,
        input.slug
      )
      if (!adopted) {
        throw new Error(
          `Photon refused the slug "${input.slug}" as taken but lists no project under it. Rename the bot, which changes the slug, and try again.`
        )
      }
      // Adoption exists for one case: this bot's own project, still upstream after this computer lost
      // its record. The slug carries the bot id, so that is the only way a bot reaches its own 409. A
      // project another bot's record already names is *not* ours to adopt — sharing one project shares
      // its stream, cursor and inbox, so the two bots would fight over every message and each would
      // judge the other's members as unknown senders.
      const holder = (await this.deps.store.bots()).find(
        (entry) => entry.projectId === adopted.id && entry.botId !== input.botId
      )
      if (holder) {
        throw new Error(
          `Photon already has a project under "${input.slug}", and this computer records it as bot ${holder.botId}'s. Two bots cannot share one project, so this bot was not given a channel: rename it to change its slug, or release the other bot's channel first.`
        )
      }
      this.log('[photon] adopted a project already holding this slug', input.slug)
      return { id: adopted.id, slug: adopted.slug }
    }
  }
}

/** Adds an assignment to a list, replacing the entry for the same handle, and never dropping another. */
function mergeAssignment(
  assignments: readonly PhotonAssignmentRecord[],
  assignment: PhotonAssignmentResult
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
