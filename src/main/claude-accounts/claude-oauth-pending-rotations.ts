import { existsSync, readFileSync, rmSync } from 'node:fs'
import { getSecretStore } from '../../shared/secret-store'
import { writeSecureFile } from '../../shared/secure-file'
import { adoptLegacyHomeStore } from '../home-directory-migration'
import {
  applyRefreshedFields,
  writeClaudeOAuthCredentialRotation,
  type ClaudeOAuthCredentialTarget
} from './claude-oauth-credential-store'

/**
 * A rotation the credential store refused to take, kept where it survives a quit.
 *
 * Why this is its own file rather than memory: the exchange has already spent the old refresh token
 * server-side, so the store now holds a token no endpoint will accept. If that replacement lives only
 * in memory, quitting Orca signs the user out of a paid account until they log in again — the store
 * keeps an expired access token and a spent refresh token, and the next `claude` launch fails auth.
 */
export type PendingClaudeOAuthRotation = {
  /** `file:<path>` or `keychain:<service>`, the identity the queue is keyed by. */
  key: string
  /** Where the login lives, so a flush after a restart knows what to write back to. */
  target: ClaudeOAuthCredentialTarget
  /** The refresh token the store is expected to still hold; a rotation made from a newer one wins. */
  spentStoreToken: string
  /** The oauth fields the exchange minted. */
  fields: Record<string, unknown>
}

const FILE_NAME = 'claude-oauth-pending-rotations.json'

// Why a tag rather than bare JSON: these are refresh tokens. A file that is not this build's sealed
// envelope is left alone rather than parsed, and nothing here ever writes the plaintext.
const ENVELOPE_PREFIX = 'orca-claude-oauth-pending:v1:sealed:'

/** Backoff for a write-back the store refused, so a locked keychain recovers without another 401. */
const ROTATION_RETRY_DELAYS_MS = [500, 2_000, 8_000] as const

const waiting = new Map<string, Omit<PendingClaudeOAuthRotation, 'key'>>()
const retryAttempts = new Map<string, number>()
let loaded = false
let overridePath: string | null = null
let scheduleRetry: (run: () => void, delayMs: number) => void = (run, delayMs) =>
  void setTimeout(run, delayMs)

/** @internal — a test's temporary home, so a run never writes the real one. */
export function setPendingRotationFilePathForTests(path: string | null): void {
  overridePath = path
}

/** @internal — a scheduler a test drives, so no case waits on a real timer. */
export function setPendingRotationRetryScheduler(
  scheduler: ((run: () => void, delayMs: number) => void) | null
): void {
  scheduleRetry = scheduler ?? ((run, delayMs) => void setTimeout(run, delayMs))
}

/** @internal — a fresh process: nothing loaded from disk and no rotation remembered. */
export function resetPendingRotationsForTests(): void {
  waiting.clear()
  retryAttempts.clear()
  loaded = false
}

export function getPendingRotationPath(): string {
  return overridePath ?? adoptLegacyHomeStore(FILE_NAME)
}

/**
 * The newest answer, over the rotation that is still waiting to be saved.
 *
 * A response that does not rotate the refresh token leaves the pending one in place, because the
 * store still holds the token it replaced. A rotation without an expiry drops the pending expiry,
 * which described a token that no longer exists.
 */
export function composeRefreshedFields(
  pending: Record<string, unknown>,
  merged: Record<string, unknown>
): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...pending, ...merged }
  if ('refreshToken' in merged && !('refreshTokenExpiresAt' in merged)) {
    delete fields.refreshTokenExpiresAt
  }
  return fields
}

/**
 * Persist what is waiting, sealed.
 *
 * Why refuse to write without sealing: the whole point of this file is to outlive a quit, and a
 * refresh token is exactly the secret the store it was refused by could not protect. Writing it as
 * plaintext would trade a sign-out for a credential on disk in the clear.
 */
function persist(): void {
  const entries: PendingClaudeOAuthRotation[] = [...waiting].map(([key, rotation]) => ({
    key,
    ...rotation
  }))
  try {
    if (entries.length === 0) {
      rmSync(getPendingRotationPath(), { force: true })
      return
    }
    if (!writePendingClaudeOAuthRotations(entries)) {
      console.warn('[claude-oauth-refresh] could not seal the pending rotation to disk')
    }
  } catch (error) {
    console.warn('[claude-oauth-refresh] could not write the pending rotation', error)
  }
}

function writePendingClaudeOAuthRotations(
  rotations: readonly PendingClaudeOAuthRotation[],
  path: string = getPendingRotationPath()
): boolean {
  let sealed: string
  try {
    sealed = getSecretStore().encryptString(JSON.stringify(rotations)).toString('base64')
  } catch {
    return false
  }
  writeSecureFile(path, `${ENVELOPE_PREFIX}${sealed}`, { durable: true })
  return true
}

/** Why an unavailable secret store reads as empty: without it the file cannot be decrypted, and the
 *  file stays for the launch that can open it. */
function readPendingClaudeOAuthRotations(
  path: string = getPendingRotationPath()
): PendingClaudeOAuthRotation[] {
  if (!existsSync(path)) {
    return []
  }
  let parsed: unknown
  try {
    const raw = readFileSync(path, 'utf8')
    if (!raw.startsWith(ENVELOPE_PREFIX)) {
      return []
    }
    parsed = JSON.parse(
      getSecretStore().decryptString(Buffer.from(raw.slice(ENVELOPE_PREFIX.length), 'base64'))
    )
  } catch {
    return []
  }
  return Array.isArray(parsed) ? parsed.filter(isPendingRotation) : []
}

function isPendingRotation(value: unknown): value is PendingClaudeOAuthRotation {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as Record<string, unknown>
  const target = record.target
  if (!target || typeof target !== 'object') {
    return false
  }
  const targetRecord = target as Record<string, unknown>
  const wellFormedTarget =
    targetRecord.kind === 'file'
      ? typeof targetRecord.path === 'string'
      : targetRecord.kind === 'keychain' &&
        typeof targetRecord.service === 'string' &&
        typeof targetRecord.account === 'string'
  return (
    typeof record.key === 'string' &&
    typeof record.spentStoreToken === 'string' &&
    !!record.fields &&
    typeof record.fields === 'object' &&
    wellFormedTarget
  )
}

/** The rotations this process knows about, hydrated from disk on first use. */
function queue(): Map<string, Omit<PendingClaudeOAuthRotation, 'key'>> {
  if (!loaded) {
    // Why set before reading: a file that refuses to be read must not be retried on every access.
    loaded = true
    for (const rotation of readPendingClaudeOAuthRotations()) {
      if (!waiting.has(rotation.key)) {
        waiting.set(rotation.key, {
          target: rotation.target,
          spentStoreToken: rotation.spentStoreToken,
          fields: rotation.fields
        })
      }
    }
  }
  return waiting
}

export function pendingRotation(key: string): Omit<PendingClaudeOAuthRotation, 'key'> | undefined {
  return queue().get(key)
}

export function rememberPendingRotation(
  key: string,
  rotation: Omit<PendingClaudeOAuthRotation, 'key'>
): void {
  queue().set(key, rotation)
  persist()
  scheduleUpcomingRetry(key)
}

export function forgetPendingRotation(key: string): void {
  queue().delete(key)
  retryAttempts.delete(key)
  persist()
}

/**
 * Write one pending rotation back; it is forgotten only once the store took it.
 *
 * Why `superseded` and `absent` also forget it: a newer login in the store owns the credential now,
 * or there is no login left to write to — retrying either would replay a spent token forever.
 */
async function flushPendingRotation(key: string): Promise<boolean> {
  const rotation = pendingRotation(key)
  if (!rotation) {
    return false
  }
  let outcome: Awaited<ReturnType<typeof writeClaudeOAuthCredentialRotation>>
  try {
    outcome = await writeClaudeOAuthCredentialRotation(
      rotation.target,
      rotation.spentStoreToken,
      (current, format) => applyRefreshedFields(current, rotation.fields, format)
    )
  } catch {
    return false
  }
  if (outcome === 'failed') {
    return false
  }
  forgetPendingRotation(key)
  return outcome === 'written'
}

/**
 * Retry a refused write-back on a short backoff.
 *
 * Why not wait for the next 401: the store that refused (a locked Keychain, a read-only disk) is
 * often transient, and the next 401 may be hours away or never come — the user is signed out until
 * then. Bounded, because a store that keeps refusing needs the quit flush and the next 401 instead.
 */
function scheduleUpcomingRetry(key: string): void {
  const attempts = retryAttempts.get(key) ?? 0
  if (attempts >= ROTATION_RETRY_DELAYS_MS.length) {
    return
  }
  retryAttempts.set(key, attempts + 1)
  scheduleRetry(() => {
    void flushPendingRotation(key)
  }, ROTATION_RETRY_DELAYS_MS[attempts])
}

/**
 * Write every rotation the store refused, including one a previous launch left behind.
 *
 * Why a quit hook needs this: an exchange spends the old refresh token server-side, so the pending
 * replacement is the only copy of a working login. Quitting without it signs the user out.
 */
export async function flushPendingClaudeOAuthRotations(): Promise<void> {
  for (const key of pendingRotationKeys()) {
    await flushPendingRotation(key)
  }
}

function pendingRotationKeys(): string[] {
  return [...queue().keys()]
}
