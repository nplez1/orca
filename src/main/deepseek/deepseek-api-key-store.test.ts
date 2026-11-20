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

const ENVELOPE_PREFIX = 'orca-deepseek-api-key:v1:'

const envelope = (kind: 'encrypted' | 'plaintext', value: string, prefix = ENVELOPE_PREFIX) =>
  `${prefix}${kind}:${Buffer.from(value, 'utf8').toString('base64')}`

function installSecretStore(sealing: boolean): void {
  setSecretStore({
    isEncryptionAvailable: () => sealing,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString('utf8'),
    describeProtectionGap: () => null
  } satisfies SecretStore)
}

let home = ''
const keyPath = (): string => join(home, HOME_DIRECTORY_NAME, 'deepseek-api-key.enc')

async function loadStore() {
  return await import('./deepseek-api-key-store')
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-deepseek-key-'))
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

describe('deepseek-api-key-store', () => {
  it('keeps the key under the Orca NP home and reads it back', async () => {
    const store = await loadStore()
    await store.saveDeepSeekApiKey('  sk-deepseek-1234567890  ')

    expect(readFileSync(keyPath(), 'utf8')).toBe(envelope('encrypted', 'sk-deepseek-1234567890'))
    await expect(store.readDeepSeekApiKey()).resolves.toBe('sk-deepseek-1234567890')
    await expect(store.hasDeepSeekApiKey()).resolves.toBe(true)
    await expect(store.getDeepSeekApiKeyProtection()).resolves.toBe('sealed')
  })

  it('refuses an empty key instead of writing one', async () => {
    const store = await loadStore()

    await expect(store.saveDeepSeekApiKey('   ')).rejects.toThrow('DeepSeek API key is required')
    await expect(store.hasDeepSeekApiKey()).resolves.toBe(false)
  })

  it('reads a plaintext envelope even with no secret store installed', async () => {
    writeFileSync(keyPath(), envelope('plaintext', 'sk-plain'))
    _resetSecretStoreForTests()
    vi.resetModules()
    const store = await loadStore()

    await expect(store.readDeepSeekApiKey()).resolves.toBe('sk-plain')
    await expect(store.getDeepSeekApiKeyProtection()).resolves.toBe('plaintext')
  })

  it('reports a sealed envelope as unreadable once the keychain is unavailable', async () => {
    writeFileSync(keyPath(), envelope('encrypted', 'sk-sealed'))
    installSecretStore(false)
    const store = await loadStore()

    await expect(store.readDeepSeekApiKey()).rejects.toThrow('could not be decrypted')
  })

  it('refuses an envelope written under another provider prefix', async () => {
    writeFileSync(keyPath(), envelope('plaintext', 'sk-minimax', 'orca-minimax-api-key:v1:'))
    const store = await loadStore()

    await expect(store.readDeepSeekApiKey()).rejects.toThrow('could not be decrypted')
  })

  it('clears the cached key and removes the file', async () => {
    const store = await loadStore()
    await store.saveDeepSeekApiKey('sk-deepseek-1234567890')

    await store.clearDeepSeekApiKey()

    await expect(store.readDeepSeekApiKey()).resolves.toBeNull()
    await expect(store.hasDeepSeekApiKey()).resolves.toBe(false)
  })
})
