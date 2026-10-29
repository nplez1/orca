import { existsSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeSecureJsonFileWithinLimit } from './bounded-secure-json-file'
import { readNodeFileSyncWithinLimit } from './node-bounded-file-reader'
import { hardenExistingSecureFile } from './secure-file'

/**
 * Creates that have been started but have not yet reported.
 *
 * Why a file of its own rather than a runtime record: a runtime record requires a `recipeResult`, and
 * the whole point of this record is that the create has not produced one yet. The store's schema is
 * also read by older builds that must keep parsing it, so widening it for a transient state would cost
 * more than one small file.
 *
 * Why it exists at all: recipes run detached. If the app is quit or killed mid-create, the script
 * finishes and writes its result into a pipe nobody holds any more, so the machine exists and nothing
 * on disk names it. Recording the intended instance id before the spawn is what lets the next startup
 * find out that a create never reported.
 */

const EPHEMERAL_VM_PROVISIONING_ATTEMPTS_FILE = 'orca-ephemeral-vm-provisioning-attempts.json'
export const MAX_EPHEMERAL_VM_PROVISIONING_ATTEMPTS_FILE_BYTES = 256 * 1024

export type EphemeralVmProvisioningAttempt = {
  /** The id passed to the create hook as `ORCA_VM_INSTANCE_ID`, and the runtime record's id. */
  instanceId: string
  recipeId: string
  repoPath: string
  repoId?: string
  projectId?: string
  workspaceId?: string
  workspaceName?: string
  startedAt: number
  /** Set by startup once a create is known never to have reported. */
  interruptedAt?: number
}

type AttemptsStore = {
  version: 1
  attempts: EphemeralVmProvisioningAttempt[]
}

export function getEphemeralVmProvisioningAttemptsPath(userDataPath: string): string {
  return join(userDataPath, EPHEMERAL_VM_PROVISIONING_ATTEMPTS_FILE)
}

export function listEphemeralVmProvisioningAttempts(
  userDataPath: string
): EphemeralVmProvisioningAttempt[] {
  const path = getEphemeralVmProvisioningAttemptsPath(userDataPath)
  if (!existsSync(path)) {
    return []
  }
  // Why swallow a read failure here and nowhere else in this file: every caller of this list is
  // either reconciling a possible leak or about to write, and neither can do anything with a corrupt
  // file except complain — while throwing would stop the startup reconcile dead. The contents are
  // what the write path has to worry about, and it sets an unreadable file aside before replacing it.
  try {
    hardenExistingSecureFile(path)
    const parsed: unknown = JSON.parse(
      readNodeFileSyncWithinLimit(
        path,
        MAX_EPHEMERAL_VM_PROVISIONING_ATTEMPTS_FILE_BYTES
      ).buffer.toString('utf8')
    )
    return readAttempts(parsed)
  } catch {
    return []
  }
}

export function upsertEphemeralVmProvisioningAttempt(
  userDataPath: string,
  attempt: EphemeralVmProvisioningAttempt
): void {
  const attempts = listEphemeralVmProvisioningAttempts(userDataPath).filter(
    (entry) => entry.instanceId !== attempt.instanceId
  )
  writeAttempts(userDataPath, [...attempts, attempt])
}

export function flagEphemeralVmProvisioningAttemptInterrupted(
  userDataPath: string,
  instanceId: string,
  interruptedAt: number
): EphemeralVmProvisioningAttempt | null {
  const attempts = listEphemeralVmProvisioningAttempts(userDataPath)
  const attempt = attempts.find((entry) => entry.instanceId === instanceId)
  if (!attempt) {
    return null
  }
  const flagged = { ...attempt, interruptedAt: attempt.interruptedAt ?? interruptedAt }
  if (flagged.interruptedAt === attempt.interruptedAt) {
    return flagged
  }
  writeAttempts(
    userDataPath,
    attempts.map((entry) => (entry.instanceId === instanceId ? flagged : entry))
  )
  return flagged
}

export function removeEphemeralVmProvisioningAttempt(
  userDataPath: string,
  instanceId: string
): void {
  const attempts = listEphemeralVmProvisioningAttempts(userDataPath)
  if (!attempts.some((entry) => entry.instanceId === instanceId)) {
    return
  }
  writeAttempts(
    userDataPath,
    attempts.filter((entry) => entry.instanceId !== instanceId)
  )
}

function writeAttempts(userDataPath: string, attempts: EphemeralVmProvisioningAttempt[]): void {
  const path = getEphemeralVmProvisioningAttemptsPath(userDataPath)
  preserveUnreadableStore(path)
  // Why absent rather than empty: no attempt in flight is the normal state, and a file that only
  // exists to hold an empty array would make "is anything pending?" a question about two shapes.
  if (attempts.length === 0) {
    rmSync(path, { force: true })
    return
  }
  writeSecureJsonFileWithinLimit(
    path,
    {
      version: 1,
      attempts: attempts.sort((a, b) => a.startedAt - b.startedAt)
    } satisfies AttemptsStore,
    MAX_EPHEMERAL_VM_PROVISIONING_ATTEMPTS_FILE_BYTES,
    { durable: true }
  )
}

/**
 * Keep an unreadable store instead of overwriting it.
 *
 * Why: this file's whole purpose is to hold the only record of a create that never reported, so a
 * write that replaced a damaged one would destroy the evidence it was written for. Renaming is also how
 * an operator gets to see what a killed process left behind.
 */
function preserveUnreadableStore(path: string): void {
  if (!existsSync(path)) {
    return
  }
  try {
    hardenExistingSecureFile(path)
    JSON.parse(
      readNodeFileSyncWithinLimit(
        path,
        MAX_EPHEMERAL_VM_PROVISIONING_ATTEMPTS_FILE_BYTES
      ).buffer.toString('utf8')
    )
  } catch {
    const aside = `${path}.unreadable`
    renameSync(path, aside)
    console.warn(`[ephemeral-vm] Moved an unreadable provisioning-attempt store to ${aside}.`)
  }
}

/**
 * Reads what it can from an untyped store.
 *
 * Why not zod: this file only holds an id and some display fields, and one unreadable record is worth
 * dropping silently — a schema error that hid every other attempt would be the same class of bug as
 * losing the attempt in the first place.
 */
function readAttempts(parsed: unknown): EphemeralVmProvisioningAttempt[] {
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.attempts)) {
    return []
  }
  const attempts: EphemeralVmProvisioningAttempt[] = []
  for (const value of parsed.attempts) {
    const attempt = toAttempt(value)
    if (attempt) {
      attempts.push(attempt)
    }
  }
  return attempts
}

function toAttempt(value: unknown): EphemeralVmProvisioningAttempt | null {
  if (!isRecord(value)) {
    return null
  }
  const instanceId = nonEmptyString(value.instanceId)
  const recipeId = nonEmptyString(value.recipeId)
  const repoPath = nonEmptyString(value.repoPath)
  if (!instanceId || !recipeId || !repoPath || typeof value.startedAt !== 'number') {
    return null
  }
  return {
    instanceId,
    recipeId,
    repoPath,
    startedAt: value.startedAt,
    ...toOptionalFields(value)
  }
}

/** Copies only the declared optional fields, so an unknown key cannot ride along into a log line. */
function toOptionalFields(
  value: Record<string, unknown>
): Pick<
  EphemeralVmProvisioningAttempt,
  'repoId' | 'projectId' | 'workspaceId' | 'workspaceName' | 'interruptedAt'
> {
  const repoId = nonEmptyString(value.repoId)
  const projectId = nonEmptyString(value.projectId)
  const workspaceId = nonEmptyString(value.workspaceId)
  const workspaceName = nonEmptyString(value.workspaceName)
  return {
    ...(repoId ? { repoId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(workspaceName ? { workspaceName } : {}),
    ...(typeof value.interruptedAt === 'number' ? { interruptedAt: value.interruptedAt } : {})
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
