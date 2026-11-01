import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secret-store'
import type * as DeepSeekApiKeyStore from './deepseek-api-key-store'

const secretStoreMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(value)),
  decryptString: vi.fn((value: Buffer) => value.toString('utf8'))
}))

const existsSyncMock = vi.fn()
const readFileSyncMock = vi.fn()
const rmSyncMock = vi.fn()
const hardenExistingSecureFileMock = vi.fn()
const writeSecureFileMock = vi.fn()
const homedirMock = vi.fn(() => '/home/test')
const adoptLegacyHomeStoreMock = vi.hoisted(() =>
  vi.fn((fileName: string) => `/home/test/.orca-np/${fileName}`)
)
vi.mock('../home-directory-migration', () => ({
  adoptLegacyHomeStore: adoptLegacyHomeStoreMock
}))

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  rmSync: rmSyncMock
}))

vi.mock('node:os', () => ({
  homedir: homedirMock
}))

vi.mock('node:path', () => ({
  join: (...parts: string[]) => parts.join('/')
}))

vi.mock('../../shared/secure-file', () => ({
  hardenExistingSecureFile: hardenExistingSecureFileMock,
  writeSecureFile: writeSecureFileMock
}))

const storePath = '/home/test/.orca-np/deepseek-api-key.enc'
const envelope = (
  kind: 'encrypted' | 'plaintext',
  value: string,
  prefix = 'orca-deepseek-api-key:v1:'
): string => `${prefix}${kind}:${Buffer.from(value, 'utf8').toString('base64')}`

async function loadStore(): Promise<typeof DeepSeekApiKeyStore> {
  setSecretStore({ ...secretStoreMock, describeProtectionGap: () => null })
  return await import('./deepseek-api-key-store')
}

describe('deepseek-api-key-store', () => {
  beforeEach(() => {
    adoptLegacyHomeStoreMock.mockClear()
    existsSyncMock.mockReset()
    readFileSyncMock.mockReset()
    rmSyncMock.mockReset()
    hardenExistingSecureFileMock.mockReset()
    writeSecureFileMock.mockReset()
    secretStoreMock.isEncryptionAvailable.mockReset()
    secretStoreMock.encryptString.mockReset()
    secretStoreMock.decryptString.mockReset()
    secretStoreMock.isEncryptionAvailable.mockReturnValue(true)
    secretStoreMock.encryptString.mockImplementation((value: string) => Buffer.from(value))
    secretStoreMock.decryptString.mockImplementation((value: Buffer) => value.toString('utf8'))
  })

  afterEach(() => {
    _resetSecretStoreForTests()
    vi.resetModules()
  })

  it('returns false when no file exists yet', async () => {
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    expect(store.hasDeepSeekApiKey()).toBe(false)
    expect(hardenExistingSecureFileMock).not.toHaveBeenCalled()
    expect(adoptLegacyHomeStoreMock).toHaveBeenCalledWith('deepseek-api-key.enc')
  })

  it('hardens the key file when checking status for an existing key', async () => {
    existsSyncMock.mockReturnValue(true)
    const store = await loadStore()
    expect(store.hasDeepSeekApiKey()).toBe(true)
    expect(hardenExistingSecureFileMock).toHaveBeenCalledWith(storePath)
  })

  it('still reports an existing key when status-path hardening fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    existsSyncMock.mockReturnValue(true)
    hardenExistingSecureFileMock.mockImplementation(() => {
      throw new Error('permission denied')
    })
    const store = await loadStore()
    expect(store.hasDeepSeekApiKey()).toBe(true)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to harden DeepSeek API key file'),
      expect.any(Error)
    )
    warn.mockRestore()
  })

  it('writes the key through the secret store when encryption is available', async () => {
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    store.saveDeepSeekApiKey('sk-deepseek-1234567890')
    expect(secretStoreMock.encryptString).toHaveBeenCalledWith('sk-deepseek-1234567890')
    expect(writeSecureFileMock).toHaveBeenCalledWith(
      storePath,
      envelope('encrypted', 'sk-deepseek-1234567890'),
      { durable: true }
    )
  })

  it('warns and writes plaintext when the secret store cannot seal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    secretStoreMock.isEncryptionAvailable.mockReturnValue(false)
    const store = await loadStore()
    store.saveDeepSeekApiKey('sk-deepseek-1234567890')
    expect(writeSecureFileMock).toHaveBeenCalledWith(
      storePath,
      envelope('plaintext', 'sk-deepseek-1234567890'),
      { durable: true }
    )
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('secret encryption unavailable'))
    warn.mockRestore()
  })

  it('refuses empty keys', async () => {
    const store = await loadStore()
    expect(() => store.saveDeepSeekApiKey('   ')).toThrow('DeepSeek API key is required')
  })

  it('refuses to seal when no secret store is installed', async () => {
    // Why this test exists: the global test setup installs a store, so dropping it is the only
    // way to reach the uninstalled path — and a save consults the port unconditionally.
    _resetSecretStoreForTests()
    vi.resetModules()
    const store = await import('./deepseek-api-key-store')

    expect(() => store.saveDeepSeekApiKey('sk-plain')).toThrow(/SecretStore not initialized/)
  })

  it('reads a plaintext envelope with no secret store installed at all', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('plaintext', 'sk-plain')))
    _resetSecretStoreForTests()
    vi.resetModules()
    const store = await import('./deepseek-api-key-store')

    expect(store.readDeepSeekApiKey()).toBe('sk-plain')
  })

  it('classifies a sealed envelope read with no store installed as a decrypt failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted', 'sk-sealed')))
    _resetSecretStoreForTests()
    vi.resetModules()
    const store = await import('./deepseek-api-key-store')

    // Why the port's own error is logged and not surfaced: an uninstalled store is unreachable
    // in production (main-process-preflight and orcad-entry both install one) and this read is
    // read-only, so the caller's decrypt classification stands — the siblings fetch the store
    // inside the same try too (openai-api-key-store, integration-credential-file).
    expect(() => store.readDeepSeekApiKey()).toThrow('could not be decrypted')
    expect(error).toHaveBeenCalledWith(
      '[deepseek] failed to decode/decrypt API key',
      expect.objectContaining({ message: expect.stringContaining('SecretStore not initialized') })
    )
    error.mockRestore()
  })

  it('reads decrypted key from disk and caches it', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted', 'encrypted-payload')))
    secretStoreMock.decryptString.mockReturnValue('sk-cached-key')
    const store = await loadStore()
    const first = store.readDeepSeekApiKey()
    const second = store.readDeepSeekApiKey()
    expect(first).toBe('sk-cached-key')
    expect(second).toBe(first)
    expect(hardenExistingSecureFileMock).toHaveBeenCalledTimes(1)
    expect(hardenExistingSecureFileMock).toHaveBeenCalledWith(storePath)
    expect(secretStoreMock.decryptString).toHaveBeenCalledTimes(1)
    expect(secretStoreMock.decryptString).toHaveBeenCalledWith(Buffer.from('encrypted-payload'))
  })

  it('returns null when no file exists', async () => {
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    expect(store.readDeepSeekApiKey()).toBeNull()
  })

  it('throws for encrypted envelopes when the secret store cannot seal', async () => {
    secretStoreMock.isEncryptionAvailable.mockReturnValue(false)
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted', 'encrypted-payload')))
    const store = await loadStore()
    expect(() => store.readDeepSeekApiKey()).toThrow('DeepSeek API key could not be decrypted')
  })

  it('throws when decryption fails', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted', 'encrypted-payload')))
    secretStoreMock.decryptString.mockImplementation(() => {
      throw new Error('boom')
    })
    const store = await loadStore()
    expect(() => store.readDeepSeekApiKey()).toThrow('DeepSeek API key could not be decrypted')
  })

  it('throws for non-envelope files (legacy sealed bytes with no prefix)', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from('raw-bytes-without-envelope'))
    const store = await loadStore()
    expect(() => store.readDeepSeekApiKey()).toThrow('DeepSeek API key could not be decrypted')
  })

  it('cannot read a MiniMax key file envelope', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(
      Buffer.from(envelope('plaintext', 'sk-minimax', 'orca-minimax-api-key:v1:'))
    )
    const store = await loadStore()
    expect(() => store.readDeepSeekApiKey()).toThrow('DeepSeek API key could not be decrypted')
  })

  it('clears the cached key and removes the file', async () => {
    let filePresent = true
    existsSyncMock.mockImplementation((path: string) => path === storePath && filePresent)
    readFileSyncMock.mockReturnValueOnce(Buffer.from(envelope('encrypted', 'encrypted-payload')))
    secretStoreMock.decryptString.mockReturnValueOnce('sk-preclear')
    const store = await loadStore()
    expect(store.readDeepSeekApiKey()).toBe('sk-preclear')
    filePresent = false
    store.clearDeepSeekApiKey()
    expect(rmSyncMock).toHaveBeenCalledWith(storePath, { force: true })
    expect(store.readDeepSeekApiKey()).toBeNull()
  })
})
