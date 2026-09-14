import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SecureCredentialStore, SecureCredentialStoreOptions } from './secure-credential-store'

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

const prefix = 'orca-factory-probe:v1:'
const options: SecureCredentialStoreOptions = {
  fileName: 'factory-probe.enc',
  envelopePrefix: prefix,
  description: 'Probe credential',
  logTag: '[probe]'
}
const storePath = '/home/test/.orca/factory-probe.enc'
const envelope = (kind: 'encrypted' | 'plaintext', value: string, forPrefix = prefix): string =>
  `${forPrefix}${kind}:${Buffer.from(value, 'utf8').toString('base64')}`

let warn: ReturnType<typeof vi.spyOn>
let error: ReturnType<typeof vi.spyOn>
let factory: {
  createSecureCredentialStore: (options: SecureCredentialStoreOptions) => SecureCredentialStore
}

function createStore(overrides: Partial<SecureCredentialStoreOptions> = {}): SecureCredentialStore {
  return factory.createSecureCredentialStore({ ...options, ...overrides })
}

describe('secure-credential-store', () => {
  beforeEach(async () => {
    factory = await import('./secure-credential-store')
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
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warn.mockRestore()
    error.mockRestore()
  })

  it('saves under the requested file name inside the Orca directory', () => {
    existsSyncMock.mockReturnValue(false)
    createStore().save('probe-value')
    expect(writeSecureFileMock).toHaveBeenCalledWith(
      storePath,
      envelope('encrypted', 'probe-value')
    )
    expect(homedirMock).toHaveBeenCalled()
  })

  it('returns false from has without hardening when no file exists', () => {
    existsSyncMock.mockReturnValue(false)
    expect(createStore().has()).toBe(false)
    expect(hardenExistingSecureFileMock).not.toHaveBeenCalled()
  })

  it('hardens the file when has sees an existing credential', () => {
    existsSyncMock.mockReturnValue(true)
    expect(createStore().has()).toBe(true)
    expect(hardenExistingSecureFileMock).toHaveBeenCalledWith(storePath)
  })

  it('warns once but keeps reporting an existing credential when status hardening fails', () => {
    existsSyncMock.mockReturnValue(true)
    hardenExistingSecureFileMock.mockImplementation(() => {
      throw new Error('permission denied')
    })
    const store = createStore()
    expect(store.has()).toBe(true)
    expect(store.has()).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      '[probe] Failed to harden Probe credential file while checking status',
      expect.any(Error)
    )
  })

  it('writes an encrypted envelope when safeStorage is available', () => {
    createStore().save('probe-value')
    expect(safeStorageMock.encryptString).toHaveBeenCalledWith('probe-value')
    expect(writeSecureFileMock).toHaveBeenCalledWith(
      storePath,
      envelope('encrypted', 'probe-value')
    )
  })

  it('warns and writes a plaintext envelope when safeStorage is unavailable', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    createStore().save('probe-value')
    expect(writeSecureFileMock).toHaveBeenCalledWith(
      storePath,
      envelope('plaintext', 'probe-value')
    )
    expect(warn).toHaveBeenCalledWith(
      '[probe] safeStorage encryption unavailable — storing Probe credential in plaintext'
    )
  })

  it('refuses blank values with the description-based message', () => {
    expect(() => createStore().save('   ')).toThrow('Probe credential is required')
    expect(writeSecureFileMock).not.toHaveBeenCalled()
  })

  it('trims the stored value', () => {
    createStore().save('  probe-value  ')
    expect(safeStorageMock.encryptString).toHaveBeenCalledWith('probe-value')
    expect(writeSecureFileMock).toHaveBeenCalledWith(
      storePath,
      envelope('encrypted', 'probe-value')
    )
  })

  it('returns null when reading a credential that was never saved', () => {
    existsSyncMock.mockReturnValue(false)
    expect(createStore().read()).toBeNull()
    expect(hardenExistingSecureFileMock).not.toHaveBeenCalled()
  })

  it('decrypts the envelope and caches the value', () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted', 'sealed-payload')))
    safeStorageMock.decryptString.mockReturnValue('probe-value')
    const store = createStore()
    expect(store.read()).toBe('probe-value')
    expect(store.read()).toBe('probe-value')
    expect(hardenExistingSecureFileMock).toHaveBeenCalledTimes(1)
    expect(safeStorageMock.decryptString).toHaveBeenCalledTimes(1)
    expect(safeStorageMock.decryptString).toHaveBeenCalledWith(
      Buffer.from('sealed-payload', 'utf8')
    )
  })

  it('reads a plaintext envelope without touching safeStorage', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('plaintext', 'probe-value')))
    expect(createStore().read()).toBe('probe-value')
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
  })

  it('still reads when read-path hardening fails', () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('plaintext', 'probe-value')))
    hardenExistingSecureFileMock.mockImplementation(() => {
      throw new Error('permission denied')
    })
    expect(createStore().read()).toBe('probe-value')
    expect(warn).toHaveBeenCalledWith(
      '[probe] Failed to harden Probe credential file while reading',
      expect.any(Error)
    )
  })

  it('throws the description-based decrypt error and logs it', () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from('raw-bytes-without-envelope'))
    expect(() => createStore().read()).toThrow('Probe credential could not be decrypted')
    expect(error).toHaveBeenCalledWith(
      '[probe] failed to decode/decrypt API key',
      expect.any(Error)
    )
  })

  it('rejects a file written under another store prefix', () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(
      Buffer.from(envelope('plaintext', 'other-value', 'orca-other-store:v1:'))
    )
    expect(() => createStore().read()).toThrow('Probe credential could not be decrypted')
  })

  it('throws when an encrypted envelope cannot be decrypted', () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted', 'sealed-payload')))
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    expect(() => createStore().read()).toThrow('Probe credential could not be decrypted')
  })

  it('clears the cache and removes the file', () => {
    existsSyncMock.mockReturnValueOnce(true)
    readFileSyncMock.mockReturnValueOnce(Buffer.from(envelope('plaintext', 'probe-value')))
    const store = createStore()
    expect(store.read()).toBe('probe-value')
    store.clear()
    expect(rmSyncMock).toHaveBeenCalledWith(storePath, { force: true })
    expect(store.read()).toBeNull()
  })

  it('keeps state per store instance rather than per envelope', () => {
    existsSyncMock.mockReturnValue(true)
    hardenExistingSecureFileMock.mockImplementation(() => {
      throw new Error('permission denied')
    })
    const first = createStore()
    const second = createStore({ fileName: 'factory-probe-2.enc' })
    expect(first.has()).toBe(true)
    expect(second.has()).toBe(true)
    expect(hardenExistingSecureFileMock).toHaveBeenCalledWith(
      '/home/test/.orca/factory-probe-2.enc'
    )
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('leaves the empty-prefix envelope kinds unreadable', () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(
      Buffer.from(`${prefix}sealed:${Buffer.from('x').toString('base64')}`)
    )
    expect(() => createStore().read()).toThrow('Probe credential could not be decrypted')
  })
})
