import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as FileUtils from '../codex-accounts/fs-utils'
import type * as GenericPassword from '../macos-keychain/generic-password'
import { setMainHttpClient } from '../network/http-client'

const fetchMock = vi.fn()
const keychain = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }))
const filesystem = vi.hoisted(() => ({ refuseWrites: false }))

vi.mock('../network/proxy-settings', () => ({
  ensureElectronProxyFromEnvironment: vi.fn(async () => {})
}))
vi.mock('../macos-keychain/generic-password', async (importOriginal) => ({
  ...(await importOriginal<typeof GenericPassword>()),
  readKeychainPassword: keychain.read,
  writeKeychainPassword: keychain.write
}))
vi.mock('../codex-accounts/fs-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof FileUtils>()
  const guard = () => {
    if (filesystem.refuseWrites) {
      throw Object.assign(new Error('EACCES: read-only file system'), { code: 'EACCES' })
    }
  }
  return {
    ...actual,
    writeFileAtomicallyIfUnchanged: (
      ...args: Parameters<typeof actual.writeFileAtomicallyIfUnchanged>
    ) => (guard(), actual.writeFileAtomicallyIfUnchanged(...args)),
    writeFileAtomically: (...args: Parameters<typeof actual.writeFileAtomically>) => (
      guard(),
      actual.writeFileAtomically(...args)
    )
  }
})

import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secret-store'
import { readClaudeOAuthCredential } from './claude-oauth-credential-store'
import {
  flushPendingClaudeOAuthRotations,
  resetPendingRotationsForTests,
  setPendingRotationFilePathForTests,
  setPendingRotationRetryScheduler
} from './claude-oauth-pending-rotations'
import {
  mergeRefreshedClaudeOAuthToken,
  refreshClaudeOAuthCredentials
} from './claude-oauth-token-refresh'

setMainHttpClient({ fetch: fetchMock, proxySession: () => null })

let pendingRotationPath = ''

// Why a stub store: the pending-rotation file is sealed, and a case that wrote it in the clear would
// be the very downgrade the file exists to avoid.
const sealedStore = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`sealed:${value}`),
  decryptString: (value: Buffer) =>
    Buffer.from(value)
      .toString('utf8')
      .replace(/^sealed:/, ''),
  describeProtectionGap: () => null
}

const roots: string[] = []

beforeEach(() => {
  vi.restoreAllMocks()
  // Why reset and not clear: these stubs queue `...Once` answers, and a test that stubs a response
  // it then never asks for would otherwise hand it to the next test.
  fetchMock.mockReset()
  keychain.read.mockReset()
  keychain.read.mockResolvedValue(null)
  keychain.write.mockReset()
  keychain.write.mockResolvedValue(undefined)
  filesystem.refuseWrites = false
  // Why every case: a pending rotation must never land in the developer's real app home, and the
  // default scheduler would leave timers running past the test that armed them.
  const pendingDir = mkdtempSync(join(tmpdir(), 'claude-oauth-pending-'))
  roots.push(pendingDir)
  pendingRotationPath = join(pendingDir, 'pending-rotations.json')
  setPendingRotationFilePathForTests(pendingRotationPath)
  resetPendingRotationsForTests()
  setPendingRotationRetryScheduler(() => {})
  setSecretStore(sealedStore)
})

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  _resetSecretStoreForTests()
})

function login(oauth: Record<string, unknown>) {
  return JSON.stringify({ claudeAiOauth: oauth })
}

/** A stored login on disk, plus the target a caller reaches it through. */
function storedFile(oauth: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'claude-oauth-refresh-'))
  roots.push(home)
  const path = join(home, '.credentials.json')
  writeFileSync(path, JSON.stringify({ ...extra, claudeAiOauth: oauth }))
  return { path, target: { kind: 'file' as const, path } }
}

/** Just past the window in which a service refusing Orca's own minted token blocks a rotation. */
function nextMintWindow(): number {
  return Date.now() + 16 * 60 * 1000
}

function tokenResponse(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }))
}

type StoredJson = { claudeAiOauth: Record<string, unknown> } & Record<string, unknown>

function readStored(path: string): StoredJson {
  return JSON.parse(readFileSync(path, 'utf8'))
}

it('writes the rotated pair back to the file it was read from', async () => {
  const { path, target } = storedFile(
    { accessToken: 'expired', refreshToken: 'refresh-1', expiresAt: 1, subscriptionType: 'max' },
    { marker: { kept: true } }
  )
  tokenResponse({
    access_token: 'fresh',
    refresh_token: 'refresh-2',
    expires_in: 3600,
    scope: 'user:profile user:inference'
  })

  const before = Date.now()
  expect(await refreshClaudeOAuthCredentials(target, 'expired')).toEqual({
    status: 'refreshed',
    accessToken: 'fresh',
    exchanged: true
  })

  const [url, init] = fetchMock.mock.calls[0]
  expect(url).toBe('https://platform.claude.com/v1/oauth/token')
  expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } })
  expect(JSON.parse(init.body)).toEqual({
    grant_type: 'refresh_token',
    refresh_token: 'refresh-1',
    client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
  })

  const written = readStored(path)
  expect(written.marker).toEqual({ kept: true })
  expect(written.claudeAiOauth).toMatchObject({
    accessToken: 'fresh',
    refreshToken: 'refresh-2',
    subscriptionType: 'max',
    scopes: ['user:profile', 'user:inference']
  })
  // Why: Claude Code reads expiresAt to decide its own refresh, so the rotation must set it.
  const expiresAt = written.claudeAiOauth.expiresAt
  expect(typeof expiresAt).toBe('number')
  expect(Number(expiresAt)).toBeGreaterThanOrEqual(before + 3_600_000)
})

it('exchanges the credential the store holds now, not the one the poll started with', async () => {
  // A Claude run rotated the login after the usage poll started.
  const { path, target } = storedFile({ accessToken: 'a', refreshToken: 'cli-rotated' })
  tokenResponse({ access_token: 'fresh' })

  expect(await refreshClaudeOAuthCredentials(target, 'a')).toMatchObject({ status: 'refreshed' })
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).refresh_token).toBe('cli-rotated')
  expect(readStored(path).claudeAiOauth.accessToken).toBe('fresh')
})

it('uses a login a Claude run stored while the poll had no access token', async () => {
  const { target } = storedFile({ accessToken: 'from-cli', refreshToken: 'cli-3' })

  expect(await refreshClaudeOAuthCredentials(target, null)).toEqual({
    status: 'refreshed',
    accessToken: 'from-cli',
    exchanged: false
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

it('spends nothing when the store already replaced the token the endpoint refused', async () => {
  const { path, target } = storedFile({ accessToken: 'refreshed-by-cli', refreshToken: 'cli-2' })

  expect(await refreshClaudeOAuthCredentials(target, 'expired-in-poll')).toEqual({
    status: 'refreshed',
    accessToken: 'refreshed-by-cli',
    exchanged: false
  })
  expect(fetchMock).not.toHaveBeenCalled()
  expect(readStored(path).claudeAiOauth).toMatchObject({
    accessToken: 'refreshed-by-cli',
    refreshToken: 'cli-2'
  })
})

it('keeps the login a re-login replaced mid-exchange', async () => {
  const { path, target } = storedFile({ accessToken: 'expired', refreshToken: 'refresh-1' })
  // Why a fresh refresh token: only a new login can produce one while ours is in flight.
  fetchMock.mockImplementationOnce(async () => {
    writeFileSync(path, login({ accessToken: 'from-login', refreshToken: 'login-refresh' }))
    return new Response(JSON.stringify({ access_token: 'fresh', refresh_token: 'refresh-2' }))
  })

  expect(await refreshClaudeOAuthCredentials(target, 'expired')).toEqual({
    status: 'refreshed',
    accessToken: 'fresh',
    exchanged: true
  })
  expect(readStored(path).claudeAiOauth).toMatchObject({
    accessToken: 'from-login',
    refreshToken: 'login-refresh'
  })
})

it('reports a store with no refresh token instead of asking the endpoint', async () => {
  const { target } = storedFile({ accessToken: 'only-an-access-token' })
  expect(await refreshClaudeOAuthCredentials(target, 'only-an-access-token')).toEqual({
    status: 'no-refresh-token'
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

it('does not replay a grant the endpoint called dead', async () => {
  const { target } = storedFile({ accessToken: 'a', refreshToken: 'revoked-refresh' })
  tokenResponse({ type: 'error', error: { type: 'invalid_grant', message: 'expired' } }, 400)

  expect(await refreshClaudeOAuthCredentials(target, 'a')).toEqual({ status: 'rejected' })
  expect(await refreshClaudeOAuthCredentials(target, 'a')).toEqual({ status: 'rejected' })
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('keeps a 4xx that is not a dead grant retryable', async () => {
  const { target } = storedFile({ accessToken: 'a', refreshToken: 'proxy-rejected' })
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify({ error: 'forbidden by egress proxy' }), { status: 403 })
  )

  expect(await refreshClaudeOAuthCredentials(target, 'a')).toEqual({ status: 'unavailable' })
  // Why: only a confirmed dead grant is written off; a second poll must still try.
  expect(await refreshClaudeOAuthCredentials(target, 'a')).toEqual({ status: 'unavailable' })
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('keeps a throttled exchange retryable', async () => {
  const { path, target } = storedFile({ accessToken: 'a', refreshToken: 'throttled-refresh' })
  const original = readFileSync(path, 'utf8')
  tokenResponse({ type: 'rate_limit_error' }, 429)

  expect(await refreshClaudeOAuthCredentials(target, 'a')).toEqual({ status: 'unavailable' })
  expect(readFileSync(path, 'utf8')).toBe(original)
})

it('reports a transport failure as retryable rather than a dead login', async () => {
  const { target } = storedFile({ accessToken: 'a', refreshToken: 'offline-refresh' })
  fetchMock.mockRejectedValueOnce(new Error('fetch failed: ENOTFOUND'))

  expect(await refreshClaudeOAuthCredentials(target, 'a')).toEqual({ status: 'unavailable' })
})

it('shares one exchange between concurrent callers', async () => {
  const { target } = storedFile({ accessToken: 'a', refreshToken: 'concurrent-refresh' })
  fetchMock.mockImplementationOnce(async () => {
    await Promise.resolve()
    return new Response(JSON.stringify({ access_token: 'fresh' }))
  })

  const outcomes = await Promise.all([
    refreshClaudeOAuthCredentials(target, 'a'),
    refreshClaudeOAuthCredentials(target, 'a')
  ])
  expect(outcomes).toEqual([
    { status: 'refreshed', accessToken: 'fresh', exchanged: true },
    { status: 'refreshed', accessToken: 'fresh', exchanged: true }
  ])
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('stops rotating for a token the service keeps refusing', async () => {
  const { target } = storedFile({ accessToken: 'expired', refreshToken: 'refused-mint-1' })
  tokenResponse({ access_token: 'minted-1', refresh_token: 'refused-mint-2' })
  expect(await refreshClaudeOAuthCredentials(target, 'expired')).toMatchObject({
    status: 'refreshed'
  })

  // The usage call was refused with the token this exchange just minted: rotating again would
  // spend a single-use token for the same answer.
  expect(await refreshClaudeOAuthCredentials(target, 'minted-1')).toEqual({ status: 'rejected' })
  expect(fetchMock).toHaveBeenCalledTimes(1)

  // Past the window the refusal is no longer trusted, and a real rotation is allowed again.
  vi.spyOn(Date, 'now').mockReturnValue(nextMintWindow())
  tokenResponse({ access_token: 'minted-3', refresh_token: 'refused-mint-3' })
  expect(await refreshClaudeOAuthCredentials(target, 'minted-1')).toMatchObject({
    status: 'refreshed'
  })
  expect(JSON.parse(fetchMock.mock.calls[1][1].body).refresh_token).toBe('refused-mint-2')
})

it('keeps the rotation when the store refuses it, and spends it on the next attempt', async () => {
  const { path, target } = storedFile({ accessToken: 'a', refreshToken: 'unwritable-1' })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  filesystem.refuseWrites = true
  tokenResponse({ access_token: 'first-token', refresh_token: 'unwritable-2' })

  // The token is valid even though the store could not take it.
  expect(await refreshClaudeOAuthCredentials(target, 'a')).toEqual({
    status: 'refreshed',
    accessToken: 'first-token',
    exchanged: true
  })
  expect(warn).toHaveBeenCalled()
  expect(readStored(path).claudeAiOauth.refreshToken).toBe('unwritable-1')

  // Why: replaying the spent token would strand the login, so the rotation is retried instead of
  // being forgotten — the next poll reaches the store and finds the pair it could not write.
  filesystem.refuseWrites = false
  expect(await refreshClaudeOAuthCredentials(target, 'a')).toEqual({
    status: 'refreshed',
    accessToken: 'first-token',
    exchanged: false
  })
  expect(readStored(path).claudeAiOauth).toMatchObject({
    accessToken: 'first-token',
    refreshToken: 'unwritable-2'
  })

  // A poll that was refused the retried token exchanges from the rotation, not from the dead one.
  // The clock moves past the mint window first: within it, the service refusing a token Orca just
  // minted is treated as a broken login rather than a reason to rotate again.
  vi.spyOn(Date, 'now').mockReturnValue(nextMintWindow())
  tokenResponse({ access_token: 'second-token', refresh_token: 'unwritable-3' })
  expect(await refreshClaudeOAuthCredentials(target, 'first-token')).toMatchObject({
    status: 'refreshed'
  })
  expect(JSON.parse(fetchMock.mock.calls[1][1].body).refresh_token).toBe('unwritable-2')
  expect(readStored(path).claudeAiOauth).toMatchObject({
    accessToken: 'second-token',
    refreshToken: 'unwritable-3'
  })
  warn.mockRestore()
})

it('keeps spending the pending rotation while the store stays unwritable', async () => {
  const { path, target } = storedFile({ accessToken: 'a', refreshToken: 'stuck-1' })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  filesystem.refuseWrites = true

  tokenResponse({ access_token: 'token-a', refresh_token: 'stuck-2' })
  expect(await refreshClaudeOAuthCredentials(target, 'a')).toMatchObject({ status: 'refreshed' })

  // Why: an exchange the store could not take must still hand the next poll something spendable,
  // so the refused token is the pending rotation's, never the one that was already spent.
  vi.spyOn(Date, 'now').mockReturnValue(nextMintWindow())
  tokenResponse({ access_token: 'token-b', refresh_token: 'stuck-3' })
  expect(await refreshClaudeOAuthCredentials(target, 'token-a')).toMatchObject({
    status: 'refreshed'
  })
  expect(JSON.parse(fetchMock.mock.calls[1][1].body).refresh_token).toBe('stuck-2')

  // The store finally accepts a write: the chain lands with the newest pair.
  filesystem.refuseWrites = false
  vi.spyOn(Date, 'now').mockReturnValue(nextMintWindow())
  tokenResponse({ access_token: 'token-c', refresh_token: 'stuck-4' })
  expect(await refreshClaudeOAuthCredentials(target, 'token-b')).toMatchObject({
    status: 'refreshed'
  })
  expect(JSON.parse(fetchMock.mock.calls[2][1].body).refresh_token).toBe('stuck-3')
  expect(readStored(path).claudeAiOauth).toMatchObject({
    accessToken: 'token-c',
    refreshToken: 'stuck-4'
  })
  warn.mockRestore()
})

it('keeps the pending rotation through a store it cannot read', async () => {
  const { path, target } = storedFile({ accessToken: 'a', refreshToken: 'unreadable-1' })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  filesystem.refuseWrites = true
  tokenResponse({ access_token: 'tok-1', refresh_token: 'unreadable-2' })
  await refreshClaudeOAuthCredentials(target, 'a')

  // A store that cannot be read is not a store that was signed out of.
  filesystem.refuseWrites = false
  rmSync(path)
  mkdirSync(path)
  expect(await refreshClaudeOAuthCredentials(target, 'tok-1')).toEqual({ status: 'unavailable' })
  expect(fetchMock).toHaveBeenCalledTimes(1)

  // Once it can be read again, the pending rotation is what gets spent — not the dead token.
  rmSync(path, { recursive: true })
  writeFileSync(path, login({ accessToken: 'a', refreshToken: 'unreadable-1' }))
  vi.spyOn(Date, 'now').mockReturnValue(nextMintWindow())
  tokenResponse({ access_token: 'tok-3', refresh_token: 'unreadable-3' })
  expect(await refreshClaudeOAuthCredentials(target, 'tok-1')).toMatchObject({
    status: 'refreshed'
  })
  expect(JSON.parse(fetchMock.mock.calls[1][1].body).refresh_token).toBe('unreadable-2')
  expect(readStored(path).claudeAiOauth).toMatchObject({
    accessToken: 'tok-3',
    refreshToken: 'unreadable-3'
  })
  warn.mockRestore()
})

it('keeps a pending rotation when a later answer rotates nothing', async () => {
  const { path, target } = storedFile({ accessToken: 'a', refreshToken: 'compose-1' })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  filesystem.refuseWrites = true
  tokenResponse({
    access_token: 'tok-a',
    refresh_token: 'compose-2',
    refresh_token_expires_in: 7200
  })
  await refreshClaudeOAuthCredentials(target, 'a')

  // Why: writing the spent token back would undo the rotation that is still waiting to be saved.
  vi.spyOn(Date, 'now').mockReturnValue(nextMintWindow())
  tokenResponse({ access_token: 'tok-b' })
  expect(await refreshClaudeOAuthCredentials(target, 'tok-a')).toMatchObject({
    status: 'refreshed'
  })
  expect(JSON.parse(fetchMock.mock.calls[1][1].body).refresh_token).toBe('compose-2')

  // A rotation with no expiry replaces the pending one, and the pending expiry goes with it.
  vi.spyOn(Date, 'now').mockReturnValue(nextMintWindow())
  tokenResponse({ access_token: 'tok-c', refresh_token: 'compose-3' })
  expect(await refreshClaudeOAuthCredentials(target, 'tok-b')).toMatchObject({
    status: 'refreshed'
  })
  expect(JSON.parse(fetchMock.mock.calls[2][1].body).refresh_token).toBe('compose-2')

  // The store finally accepts a write, and this poll spends nothing: what lands is the pending
  // rotation, and it must not carry the expiry of the token two rotations ago.
  filesystem.refuseWrites = false
  expect(await refreshClaudeOAuthCredentials(target, 'refused-elsewhere')).toEqual({
    status: 'refreshed',
    accessToken: 'tok-c',
    exchanged: false
  })
  const written = readStored(path).claudeAiOauth
  expect(written).toMatchObject({ accessToken: 'tok-c', refreshToken: 'compose-3' })
  expect(written.refreshTokenExpiresAt).toBeUndefined()
  warn.mockRestore()
})

it('writes a rotated token back to the Keychain item it was read from', async () => {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  // Both reads — the exchange and the identity check before writing — see the same item.
  keychain.read.mockResolvedValue(login({ accessToken: 'a', refreshToken: 'keychain-1' }))
  tokenResponse({ access_token: 'fresh', refresh_token: 'keychain-2' })
  const target = {
    kind: 'keychain' as const,
    service: 'Claude Code-credentials-abcd1234',
    account: 'tester'
  }

  try {
    expect(await refreshClaudeOAuthCredentials(target, 'a')).toMatchObject({ status: 'refreshed' })
    expect(keychain.read).toHaveBeenCalledWith('Claude Code-credentials-abcd1234', 'tester')
    // Why compact: `security -w` answers a non-printable item in hex, and Claude Code parses that
    // answer as JSON, so a pretty-printed login would read back as no login at all.
    const [, , written] = keychain.write.mock.calls[0]
    expect(written).toContain('"refreshToken":"keychain-2"')
    expect(written).not.toContain('\n')
  } finally {
    platform.mockRestore()
  }
})

it('never writes a Keychain item off macOS', async () => {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  keychain.read.mockResolvedValue(login({ accessToken: 'a', refreshToken: 'keychain-linux' }))
  tokenResponse({ access_token: 'fresh', refresh_token: 'keychain-linux-2' })

  try {
    // Why still refreshed: the token works this poll; only the store could not be updated.
    expect(
      await refreshClaudeOAuthCredentials(
        { kind: 'keychain', service: 'Claude Code-credentials-linux', account: 'tester' },
        'a'
      )
    ).toMatchObject({ status: 'refreshed' })
    expect(keychain.write).not.toHaveBeenCalled()
  } finally {
    platform.mockRestore()
  }
})

it('keeps the login a Keychain re-login replaced during the exchange', async () => {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  // First read: the exchange. Second read: the identity check before writing.
  keychain.read
    .mockResolvedValueOnce(login({ accessToken: 'a', refreshToken: 'keychain-1' }))
    .mockResolvedValueOnce(login({ accessToken: 'from-login', refreshToken: 'login-refresh' }))
  tokenResponse({ access_token: 'fresh', refresh_token: 'keychain-2' })

  try {
    expect(
      await refreshClaudeOAuthCredentials(
        { kind: 'keychain', service: 'Claude Code-credentials-relogin', account: 'tester' },
        'a'
      )
    ).toMatchObject({ status: 'refreshed' })
    expect(keychain.write).not.toHaveBeenCalled()
  } finally {
    platform.mockRestore()
  }
})

it('merges only the fields the endpoint answered with', () => {
  const now = 1_800_000_000_000
  expect(mergeRefreshedClaudeOAuthToken(login({ refreshToken: 'r' }), {}, now)).toBeNull()
  expect(mergeRefreshedClaudeOAuthToken('{', { access_token: 'a' }, now)).toBeNull()
  expect(
    mergeRefreshedClaudeOAuthToken(
      login({ refreshToken: 'r', scopes: ['old'] }),
      { access_token: 'a' },
      now
    )
  ).toMatchObject({ accessToken: 'a' })
  expect(
    JSON.parse(
      mergeRefreshedClaudeOAuthToken(
        login({ refreshToken: 'r', scopes: ['old'] }),
        { access_token: 'a' },
        now
      )?.raw ?? '{}'
    ).claudeAiOauth
  ).toEqual({ refreshToken: 'r', scopes: ['old'], accessToken: 'a' })
})

it('carries the refresh token expiry the endpoint reports with a rotation', () => {
  const now = 1_800_000_000_000
  const rotated = JSON.parse(
    mergeRefreshedClaudeOAuthToken(
      login({ refreshToken: 'old', refreshTokenExpiresAt: 1 }),
      { access_token: 'a', refresh_token: 'new', refresh_token_expires_in: 7200 },
      now
    )?.raw ?? '{}'
  ).claudeAiOauth
  expect(rotated).toMatchObject({ refreshToken: 'new', refreshTokenExpiresAt: now + 7_200_000 })

  // Why drop: the stored expiry described the token just rotated away.
  const silent = JSON.parse(
    mergeRefreshedClaudeOAuthToken(
      login({ refreshToken: 'old', refreshTokenExpiresAt: 1 }),
      { access_token: 'a', refresh_token: 'new' },
      now
    )?.raw ?? '{}'
  ).claudeAiOauth
  expect(silent).toEqual({ accessToken: 'a', refreshToken: 'new' })
})

it('keeps a stored expiry that still describes the token in use', () => {
  const kept = JSON.parse(
    mergeRefreshedClaudeOAuthToken(
      login({ refreshToken: 'kept', refreshTokenExpiresAt: 5 }),
      { access_token: 'a' },
      1_800_000_000_000
    )?.raw ?? '{}'
  ).claudeAiOauth
  expect(kept).toEqual({ refreshToken: 'kept', refreshTokenExpiresAt: 5, accessToken: 'a' })
})

it('tells a store it cannot read apart from one that was signed out of', async () => {
  const item = { kind: 'keychain' as const, service: 'probe', account: 'tester' }
  keychain.read.mockRejectedValueOnce(new Error('security timed out after 3000ms'))
  expect(await readClaudeOAuthCredential(item)).toEqual({ status: 'failed' })
  keychain.read.mockResolvedValueOnce(null)
  expect(await readClaudeOAuthCredential(item)).toEqual({ status: 'absent' })

  const home = mkdtempSync(join(tmpdir(), 'claude-oauth-read-'))
  roots.push(home)
  // Why a directory: reading one fails for a reason that is not "no login here".
  expect(await readClaudeOAuthCredential({ kind: 'file', path: home })).toEqual({
    status: 'failed'
  })
  expect(
    await readClaudeOAuthCredential({ kind: 'file', path: join(home, 'missing.json') })
  ).toEqual({ status: 'absent' })
})

it('keeps a refused rotation in a sealed file, and writes it back on quit', async () => {
  const { path, target } = storedFile({ accessToken: 'expired', refreshToken: 'quit-1' })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  filesystem.refuseWrites = true
  tokenResponse({ access_token: 'kept', refresh_token: 'quit-2' })

  expect(await refreshClaudeOAuthCredentials(target, 'expired')).toMatchObject({
    status: 'refreshed'
  })

  // Why a file at all: the exchange already spent quit-1 server-side, so an in-memory-only rotation
  // makes quitting Orca a sign-out that no later launch can recover from.
  expect(existsSync(pendingRotationPath)).toBe(true)
  if (process.platform !== 'win32') {
    expect(statSync(pendingRotationPath).mode & 0o777).toBe(0o600)
  }
  expect(readFileSync(pendingRotationPath, 'utf8')).not.toContain('quit-2')

  // The store takes writes again; the quit hook flushes what it refused.
  filesystem.refuseWrites = false
  await flushPendingClaudeOAuthRotations()

  expect(readStored(path).claudeAiOauth).toMatchObject({
    accessToken: 'kept',
    refreshToken: 'quit-2'
  })
  expect(existsSync(pendingRotationPath)).toBe(false)
  warn.mockRestore()
})

it('writes back a rotation a previous launch left behind', async () => {
  const { path, target } = storedFile({ accessToken: 'expired', refreshToken: 'relaunch-1' })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  filesystem.refuseWrites = true
  tokenResponse({ access_token: 'kept', refresh_token: 'relaunch-2' })
  await refreshClaudeOAuthCredentials(target, 'expired')
  filesystem.refuseWrites = false

  // A fresh process: nothing in memory, and the file is the only copy of the rotation.
  resetPendingRotationsForTests()
  await flushPendingClaudeOAuthRotations()

  expect(readStored(path).claudeAiOauth).toMatchObject({
    accessToken: 'kept',
    refreshToken: 'relaunch-2'
  })
  warn.mockRestore()
})

it('retries a refused write-back on a short backoff, without another exchange', async () => {
  const scheduled: { run: () => void; delayMs: number }[] = []
  setPendingRotationRetryScheduler((run, delayMs) => {
    scheduled.push({ run, delayMs })
  })
  const { path, target } = storedFile({ accessToken: 'expired', refreshToken: 'retry-1' })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  filesystem.refuseWrites = true
  tokenResponse({ access_token: 'kept', refresh_token: 'retry-2' })

  await refreshClaudeOAuthCredentials(target, 'expired')

  // Why scheduled at all: the store that refused is usually transient (a locked keychain), and the
  // next 401 may be hours away — waiting for it is a sign-out in the meantime.
  expect(scheduled.map((entry) => entry.delayMs)).toEqual([500])

  filesystem.refuseWrites = false
  scheduled[0].run()

  await vi.waitFor(() => {
    expect(readStored(path).claudeAiOauth).toMatchObject({
      accessToken: 'kept',
      refreshToken: 'retry-2'
    })
  })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(existsSync(pendingRotationPath)).toBe(false)
  warn.mockRestore()
})

it('never writes a refused rotation in the clear when nothing can seal it', async () => {
  _resetSecretStoreForTests()
  const { path, target } = storedFile({ accessToken: 'expired', refreshToken: 'unsealed-1' })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  filesystem.refuseWrites = true
  tokenResponse({ access_token: 'kept', refresh_token: 'unsealed-2' })

  expect(await refreshClaudeOAuthCredentials(target, 'expired')).toMatchObject({
    status: 'refreshed'
  })

  // Why nothing on disk: a refresh token the keychain refused is exactly the secret a plaintext file
  // would leak, and the in-memory copy still recovers this session once the store accepts writes.
  expect(existsSync(pendingRotationPath)).toBe(false)
  expect(warn).toHaveBeenCalledWith(
    '[claude-oauth-refresh] could not seal the pending rotation to disk'
  )

  filesystem.refuseWrites = false
  await flushPendingClaudeOAuthRotations()
  expect(readStored(path).claudeAiOauth).toMatchObject({
    accessToken: 'kept',
    refreshToken: 'unsealed-2'
  })
  warn.mockRestore()
})
