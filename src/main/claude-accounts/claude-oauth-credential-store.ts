import { readFile } from 'node:fs/promises'
import { writeFileAtomically, writeFileAtomicallyIfUnchanged } from '../codex-accounts/fs-utils'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import {
  isKeychainNotFoundError,
  readKeychainPassword,
  writeKeychainPassword
} from '../macos-keychain/generic-password'

/** Exactly where a login was read from: the only place a rotated refresh token may go back to. */
export type ClaudeOAuthCredentialTarget =
  | { kind: 'keychain'; service: string; account: string }
  | { kind: 'file'; path: string }

/** Why three states: a store that cannot be read is not a store that has been signed out of. */
export type ClaudeOAuthStoredCredential =
  | { status: 'found'; raw: string }
  | { status: 'absent' }
  | { status: 'failed' }

export type ClaudeOAuthCredentialWriteOutcome = 'written' | 'superseded' | 'absent' | 'failed'

/**
 * Why it matters per target: a Keychain item has to be printable. `security -w` answers an item
 * whose bytes are not all printable in hex, and Claude Code parses that answer as JSON, so a
 * pretty-printed login written there would read back as hex and look like no login at all.
 */
export type ClaudeOAuthCredentialFormat = 'compact' | 'pretty'

export async function readClaudeOAuthCredential(
  target: ClaudeOAuthCredentialTarget
): Promise<ClaudeOAuthStoredCredential> {
  try {
    const raw =
      target.kind === 'keychain'
        ? await readKeychainPassword(target.service, target.account)
        : await readFile(target.path, 'utf8')
    // Why: the readers answer null/throw differently for a missing item, so each absence is
    // classified where it is known rather than folded into one "no login" answer.
    return raw === null ? { status: 'absent' } : { status: 'found', raw }
  } catch (error) {
    return isMissingCredentialError(error) ? { status: 'absent' } : { status: 'failed' }
  }
}

function isMissingCredentialError(error: unknown): boolean {
  return isKeychainNotFoundError(error) || isDefinitiveAbsence(error)
}

/**
 * Write a rotation back, but only over the login it was made from.
 *
 * `spentStoreToken` is the refresh token the store is expected to still hold; when it holds a
 * different one, a `claude /login` or another poll owns the newer login and this write backs off.
 * The contents are re-derived from whatever the store holds at write time, so fields a Claude run
 * changed in the meantime survive.
 */
export function writeClaudeOAuthCredentialRotation(
  target: ClaudeOAuthCredentialTarget,
  spentStoreToken: string,
  render: (current: string, format: ClaudeOAuthCredentialFormat) => string | null
): Promise<ClaudeOAuthCredentialWriteOutcome> {
  return target.kind === 'keychain'
    ? writeKeychainRotation(target, spentStoreToken, render)
    : writeFileRotation(target, spentStoreToken, render)
}

async function writeKeychainRotation(
  target: { service: string; account: string },
  spentStoreToken: string,
  render: (current: string, format: ClaudeOAuthCredentialFormat) => string | null
): Promise<ClaudeOAuthCredentialWriteOutcome> {
  if (process.platform !== 'darwin') {
    return 'failed'
  }
  // Why re-read: the Keychain has no compare-and-set, so the identity check is only worth
  // anything against the item as it stands now, not as it stood before the request.
  const current = await readClaudeOAuthCredential({ kind: 'keychain', ...target })
  if (current.status !== 'found') {
    return current.status
  }
  if (readClaudeRefreshToken(current.raw) !== spentStoreToken) {
    return 'superseded'
  }
  const contents = render(current.raw, 'compact')
  if (!contents) {
    return 'failed'
  }
  try {
    await writeKeychainPassword(target.service, target.account, contents)
    return 'written'
  } catch {
    return 'failed'
  }
}

async function writeFileRotation(
  target: { path: string },
  spentStoreToken: string,
  render: (current: string, format: ClaudeOAuthCredentialFormat) => string | null
): Promise<ClaudeOAuthCredentialWriteOutcome> {
  // Two attempts: the guarded write fails if the file moves between our read and our rename,
  // which is the case worth re-deriving from.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await readClaudeOAuthCredential({ kind: 'file', path: target.path })
    if (current.status !== 'found') {
      return current.status
    }
    if (readClaudeRefreshToken(current.raw) !== spentStoreToken) {
      return 'superseded'
    }
    const contents = render(current.raw, 'pretty')
    if (!contents) {
      return 'failed'
    }
    try {
      if (writeFileAtomicallyIfUnchanged(target.path, current.raw, contents, { mode: 0o600 })) {
        return 'written'
      }
    } catch {
      // Why the fallback: a WSL share refuses the hard-link probe the guarded write needs, so those
      // shares have no compare-and-set at all and would never take an update otherwise. The spent
      // token was compared against the store a line above; the window is this one write.
      try {
        writeFileAtomically(target.path, contents, { mode: 0o600 })
        return 'written'
      } catch {
        return 'failed'
      }
    }
  }
  return 'failed'
}

export function readClaudeRefreshToken(credentialsJson: string): string | null {
  const token = parseClaudeOAuthBlob(credentialsJson)?.refreshToken
  return isNonEmptyString(token) ? token.trim() : null
}

export function readClaudeAccessToken(credentialsJson: string): string | null {
  const token = parseClaudeOAuthBlob(credentialsJson)?.accessToken
  return isNonEmptyString(token) ? token.trim() : null
}

/** Re-apply rotated fields onto a blob that may have moved on in ways the rotation did not touch. */
export function applyRefreshedFields(
  credentialsJson: string,
  fields: Record<string, unknown>,
  format: ClaudeOAuthCredentialFormat = 'pretty'
): string | null {
  const parsed = parseStoredOAuthBlob(credentialsJson)
  if (!parsed) {
    return null
  }
  const oauth: Record<string, unknown> = { ...parseClaudeOAuthBlob(credentialsJson), ...fields }
  // Why: a rotation that reported no expiry must drop the one that described the token it
  // replaced — Claude Code reads that field to decide whether its login has died.
  if ('refreshToken' in fields && !('refreshTokenExpiresAt' in fields)) {
    delete oauth.refreshTokenExpiresAt
  }
  parsed.claudeAiOauth = oauth
  // Why pretty by default: the credentials file is the shape Claude Code writes, so keep it
  // recognisable. The Keychain asks for compact, because only a printable item survives `-w`.
  return format === 'compact' ? JSON.stringify(parsed) : `${JSON.stringify(parsed, null, 2)}\n`
}

function parseClaudeOAuthBlob(credentialsJson: string): Record<string, unknown> | null {
  const oauth = parseStoredOAuthBlob(credentialsJson)?.claudeAiOauth
  return oauth && typeof oauth === 'object' && !Array.isArray(oauth) ? { ...oauth } : null
}

export function parseStoredOAuthBlob(credentialsJson: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(credentialsJson)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    return { ...parsed }
  } catch {
    return null
  }
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}
