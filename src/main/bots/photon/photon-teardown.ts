// Letting a bot go, in two deliberately different weights. Releasing a bot is reversible: it releases
// the numbers it holds and revokes its project key, and it never deletes the Photon project — a rollback
// that deletes a project would throw away capacity the user paid for and burn a slug that can never be
// reused. Deleting the project is the one irreversible step, so it is a separate call that must name the
// slug, and its closure is polled to a terminal state: a non-terminal result is reported as still
// closing, never as success.
import type { PhotonApi, PhotonCredential } from './photon-api'
import { PhotonApiError } from './photon-api'
import { photonClosureIsTerminal, type PhotonClosure } from './photon-contract'
import { requirePhotonProvisionedRecord } from './photon-credentials'
import type { PhotonStore } from './photon-store'

export type PhotonTeardownDeps = {
  api: PhotonApi
  store: PhotonStore
  log?: (message: string, ...rest: unknown[]) => void
  /** How many times to ask whether a deletion has finished, and how long to wait between asks. */
  closureAttempts?: number
  closureIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
}

export type PhotonReleaseOutcome = {
  botId: string
  /** The handles whose numbers were released. */
  released: string[]
  revokedKey: boolean
  /** Always true: releasing a bot never deletes its project. */
  projectKept: true
  /** Steps that failed, reported rather than thrown, so one bad number does not strand the rest. */
  problems: string[]
}

export type PhotonProjectDeletionOutcome = {
  botId: string
  projectId: string
  /** `closing` is a real, honest answer: the closure has not finished and is not success. */
  state: PhotonClosure['state']
  /** True only when the closure reached a terminal state. */
  terminal: boolean
  message: string
}

const DEFAULT_CLOSURE_ATTEMPTS = 5
const DEFAULT_CLOSURE_INTERVAL_MS = 2_000

export class PhotonTeardown {
  private readonly log: (message: string, ...rest: unknown[]) => void
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly deps: PhotonTeardownDeps) {
    this.log = deps.log ?? ((message, ...rest) => console.warn(message, ...rest))
    this.sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  }

  /**
   * The default for a deleted bot: release the numbers, revoke the key, forget the record. The project
   * stays, so the slug stays available to this bot and the capacity is not thrown away.
   */
  async releaseBot(input: {
    botId: string
    account: PhotonCredential
  }): Promise<PhotonReleaseOutcome> {
    const { api, store } = this.deps
    const record = await store.bot(input.botId)
    if (!record) {
      return {
        botId: input.botId,
        released: [],
        revokedKey: false,
        projectKept: true,
        problems: ['no record to release']
      }
    }
    const credential = (await store.projectCredential(input.botId)) ?? input.account
    const problems: string[] = []
    const released: string[] = []
    for (const assignment of record.assignments) {
      try {
        await api.releaseAssignment(credential, record.projectId, assignment.assignmentId)
        released.push(assignment.handle)
      } catch (error) {
        if (error instanceof PhotonApiError && error.isMissing) {
          // Already gone upstream is the state this wanted.
          released.push(assignment.handle)
          continue
        }
        problems.push(`could not release ${assignment.handle}: ${messageOf(error)}`)
      }
    }
    // The key is revoked only once every number is released, because a revoked key cannot authenticate
    // the retry: a release that failed with the key already gone would 401 forever and strand the bot.
    // The record is kept either way, as a tombstone naming the project its deletion still has to burn.
    let revokedKey = false
    if (record.keyId && problems.length === 0) {
      try {
        await api.revokeProjectKey(input.account, record.projectId, record.keyId)
        revokedKey = true
      } catch (error) {
        if (error instanceof PhotonApiError && error.isMissing) {
          revokedKey = true
        } else {
          problems.push(`could not revoke the project key: ${messageOf(error)}`)
        }
      }
    }
    if (revokedKey || problems.length === 0) {
      // The numbers and the key are gone; the record stays so the project can still be deleted, which
      // is the only thing left that needs the slug. `forgetBot` happens when the project is closed.
      await store.putBot({
        ...record,
        released: true,
        releasedAt: Date.now(),
        assignments: [],
        ...(revokedKey ? { keyId: undefined } : {})
      })
      if (revokedKey) {
        await store.forgetProjectKey(input.botId)
      }
    }
    return { botId: input.botId, released, revokedKey, projectKept: true, problems }
  }

  /**
   * The explicit cleanup: deletes the project, which burns the slug for every future project. It must
   * name the slug it is deleting, because there is no undo and no way to reuse the name afterwards.
   */
  async deleteProject(input: {
    botId: string
    account: PhotonCredential
    /** The slug the caller was warned about; a mismatch refuses rather than deleting a different one. */
    confirmSlug: string
    idempotencyKey?: string
  }): Promise<PhotonProjectDeletionOutcome> {
    const { api, store } = this.deps
    // The record a deletion names, not the live one: a bot that has since moved to its own Spectrum project
    // still has the provisioned project this deletion burns, kept beside the live record.
    const record = await requirePhotonProvisionedRecord(store, input.botId, 'project')
    if (input.confirmSlug !== record.slug) {
      throw new Error(
        `Refusing to delete project ${record.projectId}: the confirmation names "${input.confirmSlug}" but its slug is "${record.slug}", and the slug can never be reused.`
      )
    }
    await api.deleteProject(
      input.account,
      record.projectId,
      input.idempotencyKey ?? api.idempotencyKey()
    )
    const closure = await this.awaitClosure(input.account, record.projectId)
    if (closure.state === 'closed') {
      // Not `forgetBot` for a bot that answers on its own Spectrum project: forgetting that record would
      // leave a live channel nothing references, so only the provisioned identity this call just closed
      // goes.
      const live = await store.bot(input.botId)
      await (live?.mode === 'spectrum'
        ? store.updateBot(input.botId, (current) => ({ ...current, priorProvision: undefined }))
        : store.forgetBot(input.botId))
    }
    return {
      botId: input.botId,
      projectId: record.projectId,
      state: closure.state,
      terminal: photonClosureIsTerminal(closure),
      message:
        closure.state === 'closed'
          ? `Project ${record.slug} is closed. The slug can never be reused.`
          : closure.state === 'failed'
            ? `Project ${record.slug} did not close; Photon reports the closure failed.`
            : `Project ${record.slug} is still closing; Orca will report it as closing rather than as done.`
    }
  }

  /** Polls to a terminal state. A read that fails is not a terminal state either, so it is retried. */
  private async awaitClosure(account: PhotonCredential, projectId: string): Promise<PhotonClosure> {
    const attempts = this.deps.closureAttempts ?? DEFAULT_CLOSURE_ATTEMPTS
    const interval = this.deps.closureIntervalMs ?? DEFAULT_CLOSURE_INTERVAL_MS
    let last: PhotonClosure = { state: 'closing' }
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) {
        await this.sleep(interval)
      }
      try {
        last = await this.deps.api.getProjectClosure(account, projectId)
      } catch (error) {
        this.log('[photon] could not read a project closure; still closing', error)
        continue
      }
      if (photonClosureIsTerminal(last)) {
        return last
      }
    }
    return last
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
