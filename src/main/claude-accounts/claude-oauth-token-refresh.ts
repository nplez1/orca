import { getMainHttpClient } from '../network/http-client'
import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import {
  applyRefreshedFields,
  isFiniteNumber,
  isNonEmptyString,
  parseStoredOAuthBlob,
  readClaudeAccessToken,
  readClaudeOAuthCredential,
  readClaudeRefreshToken,
  writeClaudeOAuthCredentialRotation,
  type ClaudeOAuthCredentialTarget
} from './claude-oauth-credential-store'
import {
  composeRefreshedFields,
  forgetPendingRotation,
  pendingRotation,
  rememberPendingRotation
} from './claude-oauth-pending-rotations'

export { flushPendingClaudeOAuthRotations } from './claude-oauth-pending-rotations'

// Why these constants: the public Claude Code OAuth client, verified against the installed CLI
// (2.1.302). Orca is the holder of the credential it refreshes, so it also persists the rotation.
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
// Why generous: the timeout also covers reading the body, and a response cut off after the
// endpoint rotated the token would lose the replacement the store now needs.
const REFRESH_TIMEOUT_MS = 30_000
/** A refused refresh token is single-use, so a repeat attempt can only replay a dead grant. */
const REJECTED_REFRESH_TOKEN_LIMIT = 8

export type ClaudeOAuthRefreshOutcome =
  /** `exchanged` is false when the store already held a newer token and nothing was spent. */
  | { status: 'refreshed'; accessToken: string; exchanged: boolean }
  /** The stored login has no refresh token: only a Claude sign-in can renew it. */
  | { status: 'no-refresh-token' }
  /**
   * The stored login cannot be used: the endpoint refused the grant, or the usage service refused a
   * token this store's own exchange had just minted.
   */
  | { status: 'rejected' }
  /** A throttle, outage or transport failure: the same login may still refresh later. */
  | { status: 'unavailable' }

type TokenEndpointResponse = {
  access_token?: unknown
  expires_in?: unknown
  refresh_token?: unknown
  refresh_token_expires_in?: unknown
  scope?: unknown
}

/** The oauth fields an exchange sets, kept apart so a retry can land on a store that moved on. */
type RefreshedTokenFields = Record<string, unknown>

/** A token this store's last exchange minted, and when it did. */
type MintedToken = { accessToken: string; mintedAt: number }
/** Why bounded: a service that keeps refusing our own minted token is broken in a way a rotation
 *  cannot fix, but the refusal may also have been transient, so it is not remembered for good. */
const MINT_REFUSAL_WINDOW_MS = 15 * 60 * 1000

const inFlight = new Map<string, Promise<ClaudeOAuthRefreshOutcome>>()
const rejectedRefreshTokens = new Set<string>()
const mintedTokens = new Map<string, MintedToken>()

/**
 * Merge a token-endpoint response into the stored blob, keeping every field the caller already
 * had. Claude Code reads a fixed field set out of this object, so a partial merge would drop the
 * account metadata its `/status` renders.
 */
export function mergeRefreshedClaudeOAuthToken(
  credentialsJson: string,
  response: TokenEndpointResponse,
  now: number = Date.now()
): { raw: string; accessToken: string; fields: RefreshedTokenFields } | null {
  const accessToken = response.access_token
  if (!parseStoredOAuthBlob(credentialsJson) || !isNonEmptyString(accessToken)) {
    return null
  }
  const fields: RefreshedTokenFields = { accessToken }
  if (isFiniteNumber(response.expires_in)) {
    fields.expiresAt = now + response.expires_in * 1000
  }
  // Rotation: a single-use refresh token makes persisting the returned one the whole point.
  if (isNonEmptyString(response.refresh_token)) {
    fields.refreshToken = response.refresh_token
    if (isFiniteNumber(response.refresh_token_expires_in)) {
      fields.refreshTokenExpiresAt = now + response.refresh_token_expires_in * 1000
    }
  }
  if (isNonEmptyString(response.scope)) {
    fields.scopes = response.scope.split(' ').filter(Boolean)
  }
  const raw = applyRefreshedFields(credentialsJson, fields)
  return raw ? { raw, accessToken, fields } : null
}

/**
 * Exchange the stored refresh token for a new access token and persist the rotation.
 *
 * Never throws and never refreshes on a timer: callers reach this only after the usage endpoint
 * rejected the token, or when a refresh token is all the stored login has left. Concurrent
 * callers share one exchange, because a rotated refresh token can only be spent once.
 *
 * `refusedAccessToken` is the token the caller was told no with, or null when it had none; a store
 * that now holds a different one has already been refreshed and is used as it stands.
 */
export async function refreshClaudeOAuthCredentials(
  target: ClaudeOAuthCredentialTarget,
  refusedAccessToken: string | null
): Promise<ClaudeOAuthRefreshOutcome> {
  const key = targetKey(target)
  const running = inFlight.get(key)
  if (running) {
    return running
  }
  const exchange = exchangeClaudeOAuthToken(key, target, refusedAccessToken).finally(() =>
    inFlight.delete(key)
  )
  inFlight.set(key, exchange)
  return exchange
}

function targetKey(target: ClaudeOAuthCredentialTarget): string {
  return target.kind === 'file' ? `file:${target.path}` : `keychain:${target.service}`
}

async function exchangeClaudeOAuthToken(
  key: string,
  target: ClaudeOAuthCredentialTarget,
  refusedAccessToken: string | null
): Promise<ClaudeOAuthRefreshOutcome> {
  // Why re-read: a Claude run may have rotated the login since the usage poll started, and that
  // newer token is the one the endpoint will accept.
  let stored = await readClaudeOAuthCredential(target)
  if (await retryUnsavedRotation(key)) {
    stored = await readClaudeOAuthCredential(target)
  }
  const storeRaw = stored.status === 'found' ? stored.raw : null
  const pending = pendingRotation(key)
  const base = pending && storeRaw ? applyRefreshedFields(storeRaw, pending.fields) : storeRaw
  if (!base) {
    return { status: 'unavailable' }
  }

  // Why: spending a token the store already replaced would rotate a login that is already fine,
  // and invalidate the pair a running Claude holds.
  const storeAccessToken = readClaudeAccessToken(base)
  if (storeAccessToken && storeAccessToken !== refusedAccessToken) {
    return { status: 'refreshed', accessToken: storeAccessToken, exchanged: false }
  }
  // Why: rotating again would spend a single-use token for the same answer the service has already
  // given about a token this exchange minted. A store that holds a different token — a
  // `claude /login` — clears the memory instead.
  const minted = mintedTokens.get(key)
  if (minted && (minted.accessToken !== storeAccessToken || isStaleMint(minted))) {
    mintedTokens.delete(key)
  } else if (minted && refusedAccessToken === minted.accessToken) {
    return { status: 'rejected' }
  }

  // The token to spend, and the one the store is expected to hold afterwards: the same token
  // unless a rotation is still waiting to be written, in which case that rotation is spent and the
  // store still holds the one before it.
  const refreshToken = readClaudeRefreshToken(base)
  const spentStoreToken = pending?.spentStoreToken ?? refreshToken
  if (!refreshToken || !spentStoreToken) {
    return { status: 'no-refresh-token' }
  }
  if (rejectedRefreshTokens.has(refreshToken)) {
    return { status: 'rejected' }
  }
  await ensureElectronProxyFromEnvironment({ probeUrl: OAUTH_TOKEN_URL }).catch(() => {})

  let response: Response
  try {
    response = await getMainHttpClient().fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID
      }),
      // Why only the timeout: a poll stopping mid-request must not discard an exchange the
      // endpoint has already honoured, which would spend the token and lose its replacement.
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS)
    })
  } catch {
    return { status: 'unavailable' }
  }
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    // Why the body: a 4xx can also come from a proxy or a malformed request, and only a dead
    // grant may be written off for the rest of the session.
    return (await isRefusedGrant(response))
      ? rememberRejectedGrant(refreshToken)
      : { status: 'unavailable' }
  }
  if (!response.ok) {
    return { status: 'unavailable' }
  }
  const merged = mergeRefreshedClaudeOAuthToken(base, await readTokenResponse(response))
  if (!merged) {
    return { status: 'unavailable' }
  }
  // Why compose with the pending rotation: an answer with no new refresh token would otherwise
  // write the spent token back over the valid one that is still waiting to be saved.
  const fields = pending ? composeRefreshedFields(pending.fields, merged.fields) : merged.fields
  const written = await writeClaudeOAuthCredentialRotation(
    target,
    spentStoreToken,
    (current, format) => applyRefreshedFields(current, fields, format)
  )
  if (written === 'failed') {
    // Why keep it: the old refresh token is spent server-side, so forgetting the replacement
    // would leave the store holding a token no endpoint will accept.
    rememberPendingRotation(key, { target, spentStoreToken, fields })
    console.warn('[claude-oauth-refresh] could not persist the rotated credential')
  } else {
    forgetPendingRotation(key)
  }
  mintedTokens.set(key, { accessToken: merged.accessToken, mintedAt: Date.now() })
  return { status: 'refreshed', accessToken: merged.accessToken, exchanged: true }
}

async function retryUnsavedRotation(key: string): Promise<boolean> {
  if (!pendingRotation(key)) {
    return false
  }
  return flushPendingClaudeOAuthRotationsForKey(key)
}

/** Write one pending rotation back; it is forgotten only once the store took it. */
async function flushPendingClaudeOAuthRotationsForKey(key: string): Promise<boolean> {
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

async function isRefusedGrant(response: Response): Promise<boolean> {
  const body = await readTokenResponse(response)
  const error = body.error
  return (
    error === 'invalid_grant' ||
    body.type === 'invalid_grant' ||
    (!!error && typeof error === 'object' && 'type' in error && error.type === 'invalid_grant') ||
    (typeof body.text === 'string' && body.text.includes('invalid_grant'))
  )
}

async function readTokenResponse(response: Response): Promise<Record<string, unknown>> {
  // Why text first: a proxy or a malformed answer can make `json()` throw, and the refusal check
  // still needs something to look at.
  const text = await response.text().catch(() => '')
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? { ...parsed } : { text }
  } catch {
    return { text }
  }
}

function isStaleMint(minted: MintedToken): boolean {
  return Date.now() - minted.mintedAt > MINT_REFUSAL_WINDOW_MS
}

function rememberRejectedGrant(refreshToken: string): ClaudeOAuthRefreshOutcome {
  rejectedRefreshTokens.add(refreshToken)
  if (rejectedRefreshTokens.size > REJECTED_REFRESH_TOKEN_LIMIT) {
    const [oldest] = rejectedRefreshTokens
    rejectedRefreshTokens.delete(oldest)
  }
  return { status: 'rejected' }
}
