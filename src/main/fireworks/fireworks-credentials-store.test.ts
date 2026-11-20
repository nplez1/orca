import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetSecretStoreForTests,
  setSecretStore,
  type SecretStore
} from '../../shared/secure-storage/secret-store'
import { HOME_DIRECTORY_NAME } from '../../shared/app-directory-names'

const ENVELOPE_PREFIX = 'orca-fireworks-credentials:v1:'

const envelope = (payload: string, kind: 'encrypted' | 'plaintext' = 'encrypted') =>
  `${ENVELOPE_PREFIX}${kind}:${Buffer.from(payload, 'utf8').toString('base64')}`

function installSecretStore(sealing: boolean): void {
  setSecretStore({
    isEncryptionAvailable: () => sealing,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString('utf8'),
    describeProtectionGap: () => null
  } satisfies SecretStore)
}

let home = ''
const credentialsPath = (): string => join(home, HOME_DIRECTORY_NAME, 'fireworks-credentials.enc')

async function loadStore() {
  return await import('./fireworks-credentials-store')
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-fireworks-credentials-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  mkdirSync(join(home, HOME_DIRECTORY_NAME))
  vi.resetModules()
  installSecretStore(true)
})

afterEach(() => {
  _resetSecretStoreForTests()
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

describe('fireworks-credentials-store', () => {
  it('round-trips the key and its account override under the Orca NP home', async () => {
    const store = await loadStore()
    await store.saveFireworksCredentials({
      apiKey: '  fw-key  ',
      accountIdOverride: ' acct-1 '
    })

    expect(JSON.parse(decodeEnvelope(readFileSync(credentialsPath(), 'utf8')))).toEqual({
      apiKey: 'fw-key',
      accountIdOverride: 'acct-1'
    })
    await expect(store.readFireworksCredentials()).resolves.toEqual({
      apiKey: 'fw-key',
      accountIdOverride: 'acct-1'
    })
    await expect(store.hasFireworksCredentials()).resolves.toBe(true)
  })

  it('stores a blank override as null', async () => {
    const store = await loadStore()
    await store.saveFireworksCredentials({ apiKey: 'fw-key', accountIdOverride: '   ' })

    await expect(store.readFireworksCredentials()).resolves.toEqual({
      apiKey: 'fw-key',
      accountIdOverride: null
    })
  })

  it('refuses a blank API key instead of writing one', async () => {
    const store = await loadStore()

    await expect(
      store.saveFireworksCredentials({ apiKey: '  ', accountIdOverride: null })
    ).rejects.toThrow('Fireworks API key is required')
    await expect(store.hasFireworksCredentials()).resolves.toBe(false)
  })

  it('reports an unreadable payload as the credentials it promised, not as an API key', async () => {
    writeFileSync(credentialsPath(), envelope('not json'))
    const store = await loadStore()

    await expect(store.readFireworksCredentials()).rejects.toThrow(
      'Fireworks credentials could not be decrypted'
    )
  })

  it('refuses a payload that is missing its key', async () => {
    writeFileSync(credentialsPath(), envelope(JSON.stringify({ accountIdOverride: 'acct-1' })))
    const store = await loadStore()

    await expect(store.readFireworksCredentials()).rejects.toThrow(
      'Fireworks credentials could not be decrypted'
    )
  })

  it('reads nothing when no credentials were ever saved', async () => {
    const store = await loadStore()

    await expect(store.readFireworksCredentials()).resolves.toBeNull()
    await expect(store.hasFireworksCredentials()).resolves.toBe(false)
  })

  it('clears the cached credentials and removes the file', async () => {
    const store = await loadStore()
    await store.saveFireworksCredentials({ apiKey: 'fw-key', accountIdOverride: null })

    await store.clearFireworksCredentials()

    await expect(store.readFireworksCredentials()).resolves.toBeNull()
    await expect(store.hasFireworksCredentials()).resolves.toBe(false)
  })
})

function decodeEnvelope(raw: string): string {
  const rest = raw.slice(ENVELOPE_PREFIX.length)
  return Buffer.from(rest.slice(rest.indexOf(':') + 1), 'base64').toString('utf8')
}
