import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DeepSeekApiKeyStore from './deepseek-api-key-store'

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(value)),
  decryptString: vi.fn((value: Buffer) => value.toString('utf8'))
}))

const electronMock = vi.hoisted(() => ({
  safeStorage: safeStorageMock
}))

vi.mock('electron', () => electronMock)

const existsSyncMock = vi.fn()
const readFileSyncMock = vi.fn()
const rmSyncMock = vi.fn()
const hardenExistingSecureFileMock = vi.fn()
const writeSecureFileMock = vi.fn()
const homedirMock = vi.fn(() => '/home/test')

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

const storePath = '/home/test/.orca/deepseek-api-key.enc'
const envelope = (
  kind: 'encrypted' | 'plaintext',
  value: string,
  prefix = 'orca-deepseek-api-key:v1:'
): string => `${prefix}${kind}:${Buffer.from(value, 'utf8').toString('base64')}`

async function loadStore(): Promise<typeof DeepSeekApiKeyStore> {
  return await import('./deepseek-api-key-store')
}

describe('deepseek-api-key-store', () => {
  beforeEach(() => {
    existsSyncMock.mockReset()
    readFileSyncMock.mockReset()
    rmSyncMock.mockReset()
    hardenExistingSecureFileMock.mockReset()
    writeSecureFileMock.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReset()
    safeStorageMock.encryptString.mockReset()
    safeStorageMock.decryptString.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    safeStorageMock.encryptString.mockImplementation((value: string) => Buffer.from(value))
    safeStorageMock.decryptString.mockImplementation((value: Buffer) => value.toString('utf8'))
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('returns false when no file exists yet', async () => {
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    expect(store.hasDeepSeekApiKey()).toBe(false)
    expect(hardenExistingSecureFileMock).not.toHaveBeenCalled()
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

  it('writes the key using safeStorage when encryption is available', async () => {
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    store.saveDeepSeekApiKey('sk-deepseek-1234567890')
    expect(safeStorageMock.encryptString).toHaveBeenCalledWith('sk-deepseek-1234567890')
    expect(writeSecureFileMock).toHaveBeenCalledWith(
      storePath,
      envelope('encrypted', 'sk-deepseek-1234567890')
    )
  })

  it('warns and writes plaintext when safeStorage is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const store = await loadStore()
    store.saveDeepSeekApiKey('sk-deepseek-1234567890')
    expect(writeSecureFileMock).toHaveBeenCalledWith(
      storePath,
      envelope('plaintext', 'sk-deepseek-1234567890')
    )
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('safeStorage encryption unavailable'))
    warn.mockRestore()
  })

  it('refuses empty keys', async () => {
    const store = await loadStore()
    expect(() => store.saveDeepSeekApiKey('   ')).toThrow('DeepSeek API key is required')
  })

  it('reads decrypted key from disk and caches it', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted', 'encrypted-payload')))
    safeStorageMock.decryptString.mockReturnValue('sk-cached-key')
    const store = await loadStore()
    const first = store.readDeepSeekApiKey()
    const second = store.readDeepSeekApiKey()
    expect(first).toBe('sk-cached-key')
    expect(second).toBe(first)
    expect(hardenExistingSecureFileMock).toHaveBeenCalledTimes(1)
    expect(hardenExistingSecureFileMock).toHaveBeenCalledWith(storePath)
    expect(safeStorageMock.decryptString).toHaveBeenCalledTimes(1)
    expect(safeStorageMock.decryptString).toHaveBeenCalledWith(Buffer.from('encrypted-payload'))
  })

  it('returns null when no file exists', async () => {
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    expect(store.readDeepSeekApiKey()).toBeNull()
  })

  it('throws for encrypted envelopes when safeStorage is unavailable', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted', 'encrypted-payload')))
    const store = await loadStore()
    expect(() => store.readDeepSeekApiKey()).toThrow('DeepSeek API key could not be decrypted')
  })

  it('throws when decryption fails', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted', 'encrypted-payload')))
    safeStorageMock.decryptString.mockImplementation(() => {
      throw new Error('boom')
    })
    const store = await loadStore()
    expect(() => store.readDeepSeekApiKey()).toThrow('DeepSeek API key could not be decrypted')
  })

  it('throws for non-envelope files (legacy safeStorage bytes with no prefix)', async () => {
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
    existsSyncMock.mockReturnValueOnce(true)
    readFileSyncMock.mockReturnValueOnce(Buffer.from(envelope('encrypted', 'encrypted-payload')))
    safeStorageMock.decryptString.mockReturnValueOnce('sk-preclear')
    const store = await loadStore()
    expect(store.readDeepSeekApiKey()).toBe('sk-preclear')
    store.clearDeepSeekApiKey()
    expect(rmSyncMock).toHaveBeenCalledWith(storePath, { force: true })
    expect(store.readDeepSeekApiKey()).toBeNull()
  })
})
