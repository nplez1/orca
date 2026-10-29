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
/** Whether the file's contents are known, so a write cannot drop another account's rotation. */
let complete = false
let overridePath: string | null = null
let scheduleRetry: (run: () => void, delayMs: number) => void = (run, delayMs) =>
  void setTimeout(run, delayMs)
let isExchangeInFlight: (key: string) => boolean = () => false

/** @internal — a test's temporary home, so a run never writes the real one. */
export function setPendingRotationFilePathForTests(path: string | null): void {
  overridePath = path
}

/**
 * @internal — whether a refresh exchange for this key is running.
 *
 * Why the queue has to know: an exchange owns the write for its own key, and a retry that lands in the
 * middle of one can make the exchange's compare-and-set write `superseded` and drop a token the server
 * has already spent.
 */
export function setPendingRotationBusyProbe(probe: ((key: string) => boolean) | null): void {
  isExchangeInFlight = probe ?? (() => false)
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
  complete = false
  isExchangeInFlight = () => false
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
  // Why refuse to write what could not be read: the file may hold another account's rotation that this
  // process cannot decrypt yet (a locked keychain is the case this whole file exists for), and
  // overwriting or deleting it would destroy the only copy of that login.
  if (!complete) {
    console.warn(
      '[claude-oauth-refresh] could not read the pending rotation file; leaving it untouched'
    )
    return
  }
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

/** Why `missing` and `unreadable` are different: only the first means there is nothing to keep. */
type PendingRotationRead =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'rotations'; rotations: PendingClaudeOAuthRotation[] }

function readPendingClaudeOAuthRotations(
  path: string = getPendingRotationPath()
): PendingRotationRead {
  if (!existsSync(path)) {
    return { kind: 'missing' }
  }
  let parsed: unknown
  try {
    const raw = readFileSync(path, 'utf8')
    if (!raw.startsWith(ENVELOPE_PREFIX)) {
      return { kind: 'unreadable' }
    }
    parsed = JSON.parse(
      getSecretStore().decryptString(Buffer.from(raw.slice(ENVELOPE_PREFIX.length), 'base64'))
    )
  } catch {
    return { kind: 'unreadable' }
  }
  if (!Array.isArray(parsed)) {
    return { kind: 'unreadable' }
  }
  return { kind: 'rotations', rotations: parsed.filter(isPendingRotation) }
}

function isPendingRotation(value: unknown): value is PendingClaudeOAuthRotation {
  const record = recordOf(value)
  const target = record === null ? null : recordOf(record.target)
  if (record === null || target === null) {
    return false
  }
  const wellFormedTarget =
    target.kind === 'file'
      ? typeof target.path === 'string'
      : target.kind === 'keychain' &&
        typeof target.service === 'string' &&
        typeof target.account === 'string'
  return (
    typeof record.key === 'string' &&
    typeof record.spentStoreToken === 'string' &&
    recordOf(record.fields) !== null &&
    wellFormedTarget
  )
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...value } : null
}

/**
 * The rotations this process knows about.
 *
 * Why the read is retried while it fails: on Windows and Linux `safeStorage` cannot decrypt before the app
 * is `ready`, so the first attempt legitimately fails at startup. Treating that as "nothing pending" would
 * blind the rest of the process and let the dead token be spent.
 */
function queue(): Map<string, Omit<PendingClaudeOAuthRotation, 'key'>> {
  if (!complete) {
    complete = hydrate()
  }
  return waiting
}

/** Read the file into the queue; whether its contents are now known. */
function hydrate(): boolean {
  const read = readPendingClaudeOAuthRotations()
  if (read.kind === 'unreadable') {
    return false
  }
  for (const rotation of read.kind === 'rotations' ? read.rotations : []) {
    if (!waiting.has(rotation.key)) {
      waiting.set(rotation.key, {
        target: rotation.target,
        spentStoreToken: rotation.spentStoreToken,
        fields: rotation.fields
      })
    }
  }
  return true
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
  // Why reset: a freshly minted rotation gets its own attempts. The spent budget belonged to the token
  // this one replaced, and a long session would otherwise lose its backoff after three failures.
  retryAttempts.delete(key)
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
  // Why defer to the exchange: it is already writing this rotation under the store's compare-and-set,
  // and a second write here would make that one look superseded and drop the newer token.
  if (isExchangeInFlight(key)) {
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
  // Why the identity check: the write can block on a keychain prompt, and an exchange that started
  // meanwhile may have replaced this rotation with a newer one — forgetting it then deletes the only
  // working login.
  if (queue().get(key) !== rotation) {
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
    // Why chain the next step from here: a single 500 ms retry would make the longer delays dead code,
    // and a store that stays locked for a minute would never be retried again.
    void flushPendingRotation(key).then((written) => {
      if (!written && pendingRotation(key) !== undefined) {
        scheduleUpcomingRetry(key)
      }
    })
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

/**
 * Whether anything is waiting in this process.
 *
 * Why no disk read: the quit hook asks this on the way out, where an adoption sweep or a keychain
 * prompt must not run. A launch that never flushed hydrates nothing and leaves the file for the next
 * launch — which flushes it before any `claude` run can spend the token it replaces.
 */
export function hasPendingClaudeOAuthRotations(): boolean {
  return waiting.size > 0
}
