import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FireworksCredentialsStore from './fireworks-credentials-store'

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

const storePath = '/home/test/.orca/fireworks-credentials.enc'
const envelope = (
  kind: 'encrypted' | 'plaintext',
  value: string,
  prefix = 'orca-fireworks-credentials:v1:'
): string => `${prefix}${kind}:${Buffer.from(value, 'utf8').toString('base64')}`
const jsonEnvelope = (payload: unknown, kind: 'encrypted' | 'plaintext' = 'encrypted'): string =>
  envelope(kind, JSON.stringify(payload))

async function loadStore(): Promise<typeof FireworksCredentialsStore> {
  return await import('./fireworks-credentials-store')
}

describe('fireworks-credentials-store', () => {
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
    expect(store.hasFireworksCredentials()).toBe(false)
    expect(hardenExistingSecureFileMock).not.toHaveBeenCalled()
  })

  it('hardens the credentials file when checking status', async () => {
    existsSyncMock.mockReturnValue(true)
    const store = await loadStore()
    expect(store.hasFireworksCredentials()).toBe(true)
    expect(hardenExistingSecureFileMock).toHaveBeenCalledWith(storePath)
  })

  it('still reports existing credentials when status-path hardening fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    existsSyncMock.mockReturnValue(true)
    hardenExistingSecureFileMock.mockImplementation(() => {
      throw new Error('permission denied')
    })
    const store = await loadStore()
    expect(store.hasFireworksCredentials()).toBe(true)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to harden Fireworks credentials file'),
      expect.any(Error)
    )
    warn.mockRestore()
  })

  it('writes both fields as one encrypted JSON payload', async () => {
    const store = await loadStore()
    store.saveFireworksCredentials({ apiKey: 'fw_test_1234567890', accountIdOverride: null })
    expect(safeStorageMock.encryptString).toHaveBeenCalledWith(
      '{"apiKey":"fw_test_1234567890","accountIdOverride":null}'
    )
    expect(writeSecureFileMock).toHaveBeenCalledWith(
      storePath,
      envelope('encrypted', '{"apiKey":"fw_test_1234567890","accountIdOverride":null}')
    )
  })

  it('persists an account id override alongside the key', async () => {
    const store = await loadStore()
    store.saveFireworksCredentials({ apiKey: 'fw_test_1234567890', accountIdOverride: 'acct-42' })
    expect(writeSecureFileMock).toHaveBeenCalledWith(
      storePath,
      envelope('encrypted', '{"apiKey":"fw_test_1234567890","accountIdOverride":"acct-42"}')
    )
  })

  it('trims both fields and stores a blank override as null', async () => {
    const store = await loadStore()
    store.saveFireworksCredentials({ apiKey: '  fw_test_1234567890  ', accountIdOverride: '   ' })
    expect(writeSecureFileMock).toHaveBeenCalledWith(
      storePath,
      envelope('encrypted', '{"apiKey":"fw_test_1234567890","accountIdOverride":null}')
    )
  })

  it('refuses an empty API key', async () => {
    const store = await loadStore()
    expect(() =>
      store.saveFireworksCredentials({ apiKey: '   ', accountIdOverride: 'acct-42' })
    ).toThrow('Fireworks API key is required')
    expect(writeSecureFileMock).not.toHaveBeenCalled()
  })

  it('warns and writes a plaintext envelope when safeStorage is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const store = await loadStore()
    store.saveFireworksCredentials({ apiKey: 'fw_test_1234567890', accountIdOverride: null })
    expect(writeSecureFileMock).toHaveBeenCalledWith(
      storePath,
      envelope('plaintext', '{"apiKey":"fw_test_1234567890","accountIdOverride":null}')
    )
    expect(warn).toHaveBeenCalledWith(
      '[fireworks] safeStorage encryption unavailable — storing Fireworks credentials in plaintext'
    )
    warn.mockRestore()
  })

  it('reads both fields back from disk and caches the payload', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(
      Buffer.from(jsonEnvelope({ apiKey: 'fw_test_1234567890', accountIdOverride: 'acct-42' }))
    )
    const store = await loadStore()
    expect(store.readFireworksCredentials()).toEqual({
      apiKey: 'fw_test_1234567890',
      accountIdOverride: 'acct-42'
    })
    expect(store.readFireworksCredentials()).toEqual({
      apiKey: 'fw_test_1234567890',
      accountIdOverride: 'acct-42'
    })
    expect(hardenExistingSecureFileMock).toHaveBeenCalledTimes(1)
    expect(safeStorageMock.decryptString).toHaveBeenCalledTimes(1)
  })

  it('normalizes a missing or blank override to null when reading', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(jsonEnvelope({ apiKey: 'fw_test_1234567890' })))
    const store = await loadStore()
    expect(store.readFireworksCredentials()).toEqual({
      apiKey: 'fw_test_1234567890',
      accountIdOverride: null
    })
  })

  it('returns null when no file exists', async () => {
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    expect(store.readFireworksCredentials()).toBeNull()
  })

  it('throws when safeStorage is unavailable for an encrypted payload', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(
      Buffer.from(jsonEnvelope({ apiKey: 'fw_test_1234567890', accountIdOverride: null }))
    )
    const store = await loadStore()
    expect(() => store.readFireworksCredentials()).toThrow(
      'Fireworks credentials could not be decrypted'
    )
  })

  it('throws the decrypt error for a malformed JSON payload and logs it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted', 'not-json-at-all')))
    const store = await loadStore()
    expect(() => store.readFireworksCredentials()).toThrow(
      'Fireworks credentials could not be decrypted'
    )
    expect(error).toHaveBeenCalledWith(
      '[fireworks] failed to decode/decrypt credentials',
      expect.any(Error)
    )
    error.mockRestore()
  })

  it('throws the decrypt error for an absent payload', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('plaintext', '')))
    const store = await loadStore()
    expect(() => store.readFireworksCredentials()).toThrow(
      'Fireworks credentials could not be decrypted'
    )
  })

  it.each([
    ['a JSON array', JSON.stringify(['fw_test_1234567890'])],
    ['a JSON scalar', JSON.stringify('fw_test_1234567890')],
    ['a missing api key', JSON.stringify({ accountIdOverride: 'acct-42' })],
    ['a non-string api key', JSON.stringify({ apiKey: 42, accountIdOverride: null })],
    ['a blank api key', JSON.stringify({ apiKey: '   ', accountIdOverride: null })]
  ])('throws the decrypt error for %s', async (_label, rawPayload) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted', rawPayload)))
    const store = await loadStore()
    expect(() => store.readFireworksCredentials()).toThrow(
      'Fireworks credentials could not be decrypted'
    )
    error.mockRestore()
  })

  it('cannot read a MiniMax key file envelope', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(
      Buffer.from(envelope('plaintext', 'sk-minimax', 'orca-minimax-api-key:v1:'))
    )
    const store = await loadStore()
    expect(() => store.readFireworksCredentials()).toThrow(
      'Fireworks credentials could not be decrypted'
    )
  })

  it('clears the cached payload and removes the file', async () => {
    existsSyncMock.mockReturnValueOnce(true)
    readFileSyncMock.mockReturnValueOnce(
      Buffer.from(jsonEnvelope({ apiKey: 'fw_test_1234567890', accountIdOverride: null }))
    )
    const store = await loadStore()
    expect(store.readFireworksCredentials()).toEqual({
      apiKey: 'fw_test_1234567890',
      accountIdOverride: null
    })
    store.clearFireworksCredentials()
    expect(rmSyncMock).toHaveBeenCalledWith(storePath, { force: true })
    expect(store.readFireworksCredentials()).toBeNull()
  })
})
