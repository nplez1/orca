import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secret-store'
import type * as MiniMaxApiKeyStore from './minimax-api-key-store'

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
  isUnreadableError: (error: unknown) =>
    error instanceof Error && 'code' in error && error.code === 'EBUSY',
  writeSecureFile: writeSecureFileMock
}))

const storePath = '/home/test/.orca-np/minimax-api-key.enc'
const envelope = (kind: 'encrypted' | 'plaintext', value: string): string =>
  `orca-minimax-api-key:v1:${kind}:${Buffer.from(value, 'utf8').toString('base64')}`

async function loadStore(): Promise<typeof MiniMaxApiKeyStore> {
  setSecretStore({ ...secretStoreMock, describeProtectionGap: () => null })
  return await import('./minimax-api-key-store')
}

describe('minimax-api-key-store', () => {
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
    expect(store.hasMiniMaxApiKey()).toBe(false)
    expect(hardenExistingSecureFileMock).not.toHaveBeenCalled()
    expect(adoptLegacyHomeStoreMock).toHaveBeenCalledWith('minimax-api-key.enc')
  })

  it('hardens the key file when checking status for an existing key', async () => {
    existsSyncMock.mockReturnValue(true)
    const store = await loadStore()
    expect(store.hasMiniMaxApiKey()).toBe(true)
    expect(hardenExistingSecureFileMock).toHaveBeenCalledWith(storePath)
  })

  it('still reports an existing key when status-path hardening fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    existsSyncMock.mockReturnValue(true)
    hardenExistingSecureFileMock.mockImplementation(() => {
      throw new Error('permission denied')
    })
    const store = await loadStore()
    expect(store.hasMiniMaxApiKey()).toBe(true)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to harden MiniMax API key file'),
      expect.any(Error)
    )
    warn.mockRestore()
  })

  it('writes the key through the secret store when encryption is available', async () => {
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    store.saveMiniMaxApiKey('sk-test-1234567890')
    expect(secretStoreMock.encryptString).toHaveBeenCalledWith('sk-test-1234567890')
    expect(writeSecureFileMock).toHaveBeenCalledWith(
      storePath,
      envelope('encrypted', 'sk-test-1234567890'),
      { durable: true }
    )
  })

  it('warns and writes plaintext when the secret store cannot seal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    secretStoreMock.isEncryptionAvailable.mockReturnValue(false)
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    store.saveMiniMaxApiKey('sk-test-1234567890')
    expect(writeSecureFileMock).toHaveBeenCalledWith(
      storePath,
      envelope('plaintext', 'sk-test-1234567890'),
      { durable: true }
    )
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('secret encryption unavailable'))
    warn.mockRestore()
  })

  describe('getMiniMaxApiKeyProtection', () => {
    it('reports null when nothing is stored', async () => {
      existsSyncMock.mockReturnValue(false)
      const store = await loadStore()
      expect(store.getMiniMaxApiKeyProtection()).toBeNull()
    })

    it('reports plaintext for a plaintext envelope', async () => {
      existsSyncMock.mockReturnValue(true)
      readFileSyncMock.mockReturnValue(Buffer.from(envelope('plaintext', 'sk-test-1234567890')))
      const store = await loadStore()
      expect(store.getMiniMaxApiKeyProtection()).toBe('plaintext')
    })

    it('reports sealed for an encrypted envelope', async () => {
      existsSyncMock.mockReturnValue(true)
      readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted', 'sk-test-1234567890')))
      const store = await loadStore()
      expect(store.getMiniMaxApiKeyProtection()).toBe('sealed')
    })

    it('does not decrypt, so opening Settings cannot trigger a keychain prompt', async () => {
      existsSyncMock.mockReturnValue(true)
      readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted', 'sk-test-1234567890')))
      const store = await loadStore()
      store.getMiniMaxApiKeyProtection()
      expect(secretStoreMock.decryptString).not.toHaveBeenCalled()
      expect(secretStoreMock.isEncryptionAvailable).not.toHaveBeenCalled()
    })

    it('reports null for an unreadable envelope rather than guessing', async () => {
      existsSyncMock.mockReturnValue(true)
      readFileSyncMock.mockReturnValue(Buffer.from('not-an-orca-envelope'))
      const store = await loadStore()
      expect(store.getMiniMaxApiKeyProtection()).toBeNull()
    })
  })

  it('refuses empty keys', async () => {
    const store = await loadStore()
    expect(() => store.saveMiniMaxApiKey('   ')).toThrow(/required/)
  })

  it('reads decrypted key from disk and caches it', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted', 'encrypted-payload')))
    secretStoreMock.decryptString.mockReturnValue('sk-cached-key')
    const store = await loadStore()
    const first = store.readMiniMaxApiKey()
    const second = store.readMiniMaxApiKey()
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
    expect(store.readMiniMaxApiKey()).toBeNull()
  })

  it('throws for encrypted envelopes when the secret store cannot seal', async () => {
    secretStoreMock.isEncryptionAvailable.mockReturnValue(false)
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted', 'encrypted-payload')))
    const store = await loadStore()
    expect(() => store.readMiniMaxApiKey()).toThrow(/could not be decrypted/)
  })

  it('throws when decryption fails', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted', 'encrypted-payload')))
    secretStoreMock.decryptString.mockImplementation(() => {
      throw new Error('boom')
    })
    const store = await loadStore()
    expect(() => store.readMiniMaxApiKey()).toThrow(/could not be decrypted/)
  })

  it('throws for non-envelope files (legacy sealed bytes with no prefix)', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from('raw-bytes-without-envelope'))
    const store = await loadStore()
    expect(() => store.readMiniMaxApiKey()).toThrow(/could not be decrypted/)
  })

  it('reports a transient read failure as unreadable, not undecryptable, and retries next read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('resource busy'), { code: 'EBUSY' })
    })
    readFileSyncMock.mockReturnValueOnce(Buffer.from(envelope('encrypted', 'encrypted-payload')))
    secretStoreMock.decryptString.mockReturnValueOnce('sk-after-retry')
    const store = await loadStore()
    expect(() => store.readMiniMaxApiKey()).toThrow('MiniMax API key file could not be read')
    expect(error).not.toHaveBeenCalled()
    expect(store.readMiniMaxApiKey()).toBe('sk-after-retry')
    warn.mockRestore()
    error.mockRestore()
  })

  it('clears the cached key and removes the file', async () => {
    let filePresent = true
    existsSyncMock.mockImplementation((path: string) => path === storePath && filePresent)
    readFileSyncMock.mockReturnValueOnce(Buffer.from(envelope('encrypted', 'encrypted-payload')))
    secretStoreMock.decryptString.mockReturnValueOnce('sk-preclear')
    const store = await loadStore()
    expect(store.readMiniMaxApiKey()).toBe('sk-preclear')
    filePresent = false
    store.clearMiniMaxApiKey()
    expect(rmSyncMock).toHaveBeenCalledWith(storePath, { force: true })
    expect(store.readMiniMaxApiKey()).toBeNull()
  })
})
